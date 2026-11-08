/* Chronos — Historical Evidence Explorer (static build for Netlify)
 * Europeana, Wikidata and Wikipedia are called straight from the browser (CORS-enabled).
 * Smithsonian (optional) goes through a Netlify Function so its key stays server-side. The chatbot uses Wikipedia only — no AI, no keys.
 */
"use strict";

const CFG = {
  EUROPEANA_KEY: "api2demo", // public demo key; replace with your own free key for production
  EUROPEANA: "https://api.europeana.eu/record/v2/search.json",
  WIKIDATA: "https://query.wikidata.org/sparql",
  WIKI_ACTION: "https://en.wikipedia.org/w/api.php",
  WIKI_SUMMARY: "https://en.wikipedia.org/api/rest_v1/page/summary/",
  SMITHSONIAN_FN: "/.netlify/functions/smithsonian",
  MAX: 50,
  EUROPEANA_ROWS: 100,
  GALLERY_INITIAL: 36,
  GALLERY_STEP: 24,
  TIMEOUT: 15000,
};

const COLORS = {
  RED: "#8C3934", INK: "#332D27", INK_SOFT: "#5F5448", BROWN: "#766756",
  GOLD: "#B59A69", PARCH: "#E9D8BC", PARCH2: "#DFCEB3",
};
const NODE_COLORS = {
  Civilization: COLORS.RED, Artifact: COLORS.INK_SOFT, Museum: COLORS.GOLD, "Historical Site": COLORS.BROWN, "Archive Source": "#55756B",
};

const state = { query: "", records: [], context: null, graphSummary: "" };

/* ───────── helpers ───────── */
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const first = (v) => (Array.isArray(v) ? (v.length ? v[0] : "") : v ?? "");
const text = (v) => String(first(v) ?? "");
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

async function getJSON(url, params = {}) {
  const u = new URL(url, location.origin);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), CFG.TIMEOUT);
  try {
    const r = await fetch(u, { signal: ctl.signal, headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (e) {
    console.warn("Request failed:", u.host, e);
    return null;
  } finally {
    clearTimeout(t);
  }
}

function extractYear(s) {
  if (!s) return null;
  s = String(s);
  const iso = s.match(/^(-\d{1,6})-\d{2}-\d{2}/); // Wikidata BCE dates, e.g. -2500-01-01T…
  if (iso) return parseInt(iso[1], 10);
  const m = s.match(/\b(1\d{3}|2\d{3}|-?\d{1,4})\b/);
  return m ? parseInt(m[1], 10) : null;
}

function centuryLabel(y) {
  if (y === null || y === undefined) return "Unknown";
  if (y <= 0) return `${Math.floor(Math.abs(y) / 100) + 1}th century BCE`;
  const c = Math.floor(y / 100) + 1;
  const k = c % 100 >= 11 && c % 100 <= 13 ? 0 : c % 10;
  const suf = { 1: "st", 2: "nd", 3: "rd" }[k] || "th";
  return `${c}${suf} century CE`;
}

function evidenceScore(sources) {
  const n = new Set(sources).size;
  if (n === 0) return [1, "Unverified"];
  if (n === 1) return [2, "Limited evidence"];
  if (n === 2) return [4, "Corroborated"];
  return [5, "Well-supported"];
}

function normalize(raw) {
  return {
    title: text(raw.title) || "Untitled",
    description: text(raw.description),
    year: raw.year ?? null,
    image_url: safeUrl(text(raw.image_url)),
    source_url: safeUrl(text(raw.source_url)),
    museum: text(raw.museum) || "Unknown",
    country: text(raw.country),
    source: text(raw.source),
    lat: raw.lat ?? null,
    lon: raw.lon ?? null,
  };
}

function dedupe(records) {
  const seen = new Set();
  return records.filter((r) => {
    const k = r.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ───────── connectors ───────── */
async function fetchEuropeana(q) {
  const d = await getJSON(CFG.EUROPEANA, {
    wskey: CFG.EUROPEANA_KEY, query: q, rows: CFG.EUROPEANA_ROWS, profile: "rich", media: "true", thumbnail: "true", sort: "has_thumbnails+desc,score+desc",
  });
  if (!d) return [];
  return (d.items || []).map((it) => ({
    title: text(it.title) || text(it.dcTitleLangAware?.en) || "Untitled",
    description: text(it.dcDescriptionLangAware?.en) || text(it.dcDescription),
    year: extractYear(text(it.year) || text(it.edmTimespanLabel?.def)),
    image_url: text(it.edmPreview) || text(it.edmObject) || text(it.edmIsShownBy),
    source_url: text(it.guid),
    museum: text(it.dataProvider) || text(it.provider) || "Europeana",
    country: text(it.country),
    source: "Europeana",
  }));
}

async function fetchWikidata(q) {
  const safe = q.replace(/["\\]/g, "");
  const sparql = `
SELECT DISTINCT ?item ?itemLabel ?description ?image ?inception ?locationLabel ?coords ?countryLabel
WHERE {
  ?item rdfs:label ?itemLabel .
  FILTER(LANG(?itemLabel) = "en")
  FILTER(CONTAINS(LCASE(?itemLabel), LCASE("${safe}")))
  OPTIONAL { ?item schema:description ?description . FILTER(LANG(?description)="en") }
  OPTIONAL { ?item wdt:P18 ?image }
  OPTIONAL { ?item wdt:P571 ?inception }
  OPTIONAL { ?item wdt:P276 ?location . ?location rdfs:label ?locationLabel . FILTER(LANG(?locationLabel)="en") }
  OPTIONAL { ?item wdt:P625 ?coords }
  OPTIONAL { ?item wdt:P17 ?country . ?country rdfs:label ?countryLabel . FILTER(LANG(?countryLabel)="en") }
}
LIMIT ${CFG.MAX}`;
  const d = await getJSON(CFG.WIKIDATA, { query: sparql, format: "json" });
  if (!d) return [];
  return (d.results?.bindings || []).map((row) => {
    const v = (k) => row[k]?.value || "";
    const m = v("coords").match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
    return {
      title: v("itemLabel") || "Untitled",
      description: v("description"),
      year: extractYear(v("inception")),
      image_url: v("image"),
      source_url: v("item"),
      museum: v("locationLabel") || "Wikidata",
      country: v("countryLabel"),
      source: "Wikidata",
      lat: m ? parseFloat(m[2]) : null,
      lon: m ? parseFloat(m[1]) : null,
    };
  });
}

async function fetchSmithsonian(q) {
  const d = await getJSON(CFG.SMITHSONIAN_FN, { q, rows: CFG.MAX });
  if (!d || d.error) return [];
  return (d.response?.rows || []).map((it) => {
    const c = it.content || {};
    const dn = c.descriptiveNonRepeating || {};
    const ft = c.freetext || {};
    const media = dn.online_media?.media || [];
    return {
      title: dn.title?.content || it.title || "Untitled",
      description: (ft.notes || [{}])[0]?.content || "",
      year: extractYear((ft.date || [{}])[0]?.content || ""),
      image_url: media[0]?.content || "",
      source_url: it.id ? `https://www.si.edu/object/${it.id}` : "",
      museum: dn.data_source?.content || "Smithsonian",
      country: "",
      source: "Smithsonian",
    };
  });
}

async function fetchWikipediaSummary(q) {
  const s = await getJSON(CFG.WIKI_ACTION, {
    action: "query", list: "search", srsearch: q, format: "json", srlimit: 1, origin: "*",
  });
  const hit = s?.query?.search?.[0];
  if (!hit) return null;
  const sum = await getJSON(CFG.WIKI_SUMMARY + encodeURIComponent(hit.title.replace(/ /g, "_")));
  if (!sum || sum.type === "disambiguation") return null;
  return {
    title: sum.title || hit.title,
    description: sum.description || "",
    extract: sum.extract || "",
    thumbnail: sum.thumbnail?.source || "",
    url: sum.content_urls?.desktop?.page || "",
  };
}

async function fetchAll(q) {
  const results = await Promise.allSettled([fetchEuropeana(q), fetchWikidata(q), fetchSmithsonian(q)]);
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

/* ───────── graph ───────── */
const GENERIC_MUSEUMS = ["Unknown", "Europeana", "Wikidata", "Smithsonian"];

function buildGraph(records, query) {
  const nodes = new Map(), edges = [];
  const root = query.replace(/\b\w/g, (c) => c.toUpperCase());
  nodes.set(root, { kind: "Civilization", detail: `<b>${esc(root)}</b><br>Search term · ${records.length} matching or related archive record(s) retrieved<br>This is the inquiry at the centre of the graph, not a historical period boundary.` });
  for (const r of records.slice(0, 30)) {
    const title = clip(r.title, 40);
    const museum = clip(r.museum || "Unknown", 30);
    const country = (r.country || "").slice(0, 20);
    if (!nodes.has(title)) {
      nodes.set(title, {
        kind: "Artifact",
        detail: `<b>${esc(r.title)}</b><br>Year: ${r.year ?? "Unknown"}<br>Museum: ${esc(r.museum)}<br>Country: ${esc(r.country || "Unknown")}<br>Source: ${esc(r.source)}`,
      });
    }
    edges.push([root, title]);
    // Explicit source nodes make it clear which connected archive returned each catalogue entry.
    const sourceLabel = `Source: ${r.source || "Unknown archive"}`;
    if (!nodes.has(sourceLabel)) nodes.set(sourceLabel, { kind: "Archive Source", detail: `<b>${esc(r.source || "Unknown archive")}</b><br>Archive / catalogue source<br>This source returned a record for the current search. The graph indicates record availability, not necessarily a literal word-for-word mention in the full source text.` });
    edges.push([title, sourceLabel]);
    if (museum && !GENERIC_MUSEUMS.includes(r.museum)) {
      if (!nodes.has(museum)) nodes.set(museum, { kind: "Museum", detail: `<b>${esc(r.museum)}</b><br>Museum / collection` });
      edges.push([title, museum]);
    }
    if (country) {
      if (!nodes.has(country)) nodes.set(country, { kind: "Historical Site", detail: `<b>${esc(country)}</b><br>Country of origin / holding institution` });
      edges.push([root, country]);
    }
  }
  return { nodes, edges, root };
}

function renderGraph(G, el) {
  const ids = [...G.nodes.keys()];
  const size = { Civilization: 28, Artifact: 14, Museum: 11, "Historical Site": 11 };
  const mkTip = (html) => { const d = document.createElement("div"); d.innerHTML = html; d.style.cssText = "font:12px 'IBM Plex Sans',sans-serif;padding:4px"; return d; };
  const nodes = new vis.DataSet(ids.map((id, i) => {
    const n = G.nodes.get(id);
    return {
      id: i, label: id.length > 18 ? id.slice(0, 16) + "…" : id, title: mkTip(n.detail), group: n.kind, detail: n.detail, kind: n.kind,
      size: size[n.kind] || 12, color: { background: NODE_COLORS[n.kind], border: COLORS.PARCH },
      font: { face: "EB Garamond", size: 13, color: COLORS.INK },
    };
  }));
  const idx = new Map(ids.map((id, i) => [id, i]));
  const seen = new Set();
  const edges = new vis.DataSet(G.edges.filter(([a, b]) => {
    const k = a + "|" + b; if (seen.has(k)) return false; seen.add(k); return true;
  }).map(([a, b]) => ({ from: idx.get(a), to: idx.get(b), color: { color: COLORS.BROWN, opacity: 0.5 }, width: 0.8 })));
  const network = new vis.Network(el, { nodes, edges }, {
    nodes: { shape: "dot", borderWidth: 1.2 },
    physics: { solver: "forceAtlas2Based", forceAtlas2Based: { gravitationalConstant: -90, springLength: 120 }, stabilization: { iterations: 250 } },
    interaction: { hover: true, tooltipDelay: 80 },
  });
  network.on("click", async (event) => {
    if (!event.nodes.length) return;
    const node = nodes.get(event.nodes[0]);
    const panel = $("#graph-detail");
    if (!panel || !node) return;
    const related = G.nodes.get(ids[node.id]);
    panel.innerHTML = `<div class="detail-kicker">${esc(related.kind)} · Why it appears here</div><h3>${esc(ids[node.id])}</h3><p>${related.detail.replace(/<br\s*\/?\s*>/gi, " · ").replace(/<[^>]*>/g, "")}</p><p class="detail-explain">${esc(graphRelationship(ids[node.id], G))}</p>`;
    panel.classList.add("is-open");
  });
}

function graphRelationship(id, G) {
  const links = G.edges.filter(([a,b]) => a === id || b === id).map(([a,b]) => a === id ? b : a);
  if (id === G.root) return `This is the search term. Follow the links to see which catalogue records were returned and which archives, collections, or country labels are associated with them. This is a record-discovery map, not a complete full-text index; a connection does not guarantee that the exact term appears verbatim in every linked record.`;
  if (G.nodes.get(id)?.kind === "Archive Source") return `This archive/source returned one or more records for the current search. Open the linked record nodes to inspect individual titles and source links. Availability means a matching or related catalogue record was retrieved; it does not by itself prove the exact search phrase appears in the full text of every report.`;
  if (!links.length) return `This record has no explicit connection in the retrieved data beyond its own entry.`;
  return `Connected to ${links.slice(0, 5).join(", ")}${links.length > 5 ? ` and ${links.length - 5} more node(s)` : ""}. These links represent shared topic, recorded country, or holding institution—not a claim of direct historical influence.`;
}

/* Deterministic, data-derived summary (no AI). */
function summarizeGraph(G, records, query) {
  const deg = new Map();
  G.edges.forEach(([a, b]) => { deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1); });
  const uniqEdges = new Set(G.edges.map((e) => e.join("|"))).size;
  const byKind = {};
  G.nodes.forEach((n) => (byKind[n.kind] = (byKind[n.kind] || 0) + 1));
  const top = (kind) => [...G.nodes.entries()].filter(([, n]) => n.kind === kind)
    .sort((a, b) => (deg.get(b[0]) || 0) - (deg.get(a[0]) || 0)).slice(0, 3)
    .map(([k]) => `${k} (${deg.get(k) || 0})`);
  const museums = top("Museum"), countries = top("Historical Site");
  const root = G.root;
  const parts = [];
  parts.push(`The network centres on “${root}” and shows where matching or related catalogue records were retrieved: ${byKind.Artifact || 0} record nodes, ${byKind["Archive Source"] || 0} archive-source nodes, ${byKind.Museum || 0} named institutions, and ${byKind["Historical Site"] || 0} country labels, connected by ${uniqEdges} metadata links.`);
  if (museums.length) parts.push(`The most connected holding institutions are ${museums.join(", ")}; the number in brackets is how many links each node has.`);
  if (countries.length) parts.push(`Countries appearing most often: ${countries.join(", ")}.`);
  const srcs = [...new Set(records.map((r) => r.source))];
  parts.push(`Archive sources represented: ${srcs.join(", ")}. Use source and record nodes to find where catalogue entries or reports are available. The graph is not a guaranteed full-text search: a connection means the source returned a matching or related record, not necessarily that the exact term appears verbatim in the complete report. Positions show relationships only, not real-world distance or proof of historical influence.`);
  return parts;
}

/* ───────── timeline (SVG, with label collision handling) ───────── */
function renderTimeline(events) {
  const W = Math.max(1000, events.length * 70), padX = 70, mid = 0;
  const years = events.map((e) => e.year);
  const minY = Math.min(...years), maxY = Math.max(...years);
  const span = Math.max(maxY - minY, 10);
  const x = (y) => padX + ((y - minY) / span) * (W - padX * 2);
  const fs = 11, cw = fs * 0.52;
  const slots = { 1: {}, "-1": {} };
  const place = events.map((e, i) => {
    const label = clip(e.title, 28);
    const w = Math.max(label.length, String(e.year).length) * cw + 10;
    const sign = i % 2 === 0 ? 1 : -1;
    const s = x(e.year) - w / 2, t = x(e.year) + w / 2;
    let lvl = 1;
    for (;;) {
      const occ = (slots[sign][lvl] ||= []);
      if (!occ.some(([a, b]) => s < b && t > a)) { occ.push([s, t]); break; }
      lvl++;
    }
    return { e, label, sign, lvl };
  });
  const maxLvl = Math.max(...place.map((p) => p.lvl));
  const step = 34, H = 60 + maxLvl * step * 2, cy = H / 2;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  svg += `<line x1="20" x2="${W - 20}" y1="${cy}" y2="${cy}" stroke="${COLORS.INK}" stroke-width="1.1"/>`;
  place.forEach((p, i) => {
    const px = x(p.e.year), off = 18 + (p.lvl - 1) * step, ty = cy - p.sign * off;
    const col = i % 2 === 0 ? COLORS.RED : COLORS.GOLD;
    svg += `<line x1="${px}" x2="${px}" y1="${cy}" y2="${ty}" stroke="${COLORS.BROWN}" stroke-width=".7"/>`;
    svg += `<circle class="timeline-point" data-event-index="${i}" tabindex="0" role="button" aria-label="Open ${esc(p.e.title)}" cx="${px}" cy="${cy}" r="5.5" fill="${col}" stroke="${COLORS.PARCH}" stroke-width="1.5"/>`;
    const y1 = p.sign > 0 ? ty - 14 : ty + 12, y2 = p.sign > 0 ? ty - 2 : ty + 24;
    svg += `<text class="timeline-label" data-event-index="${i}" x="${px}" y="${y1}" font-size="${fs}" text-anchor="middle" style="fill:${COLORS.INK}">${esc(p.e.year)}</text>`;
    svg += `<text class="timeline-label" data-event-index="${i}" x="${px}" y="${y2}" font-size="${fs}" text-anchor="middle"><title>${esc(p.e.title)}</title>${esc(p.label)}</text>`;
  });
  return svg + "</svg>";
}

/* ───────── deep summary + export helpers ───────── */
function buildDeepSummary(query, records, context, G, graphParts) {
  const dated = records.filter(r => Number.isFinite(r.year)).sort((a,b) => a.year-b.year);
  const images = records.filter(r => !!r.image_url);
  const mapped = records.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  const sources = [...new Set(records.map(r => r.source).filter(Boolean))];
  const institutions = [...new Set(records.map(r => r.museum).filter(m => m && !GENERIC_MUSEUMS.includes(m)))];
  const countries = [...new Set(records.map(r => r.country).filter(Boolean))];
  const edges = G ? G.edges.filter((edge, i, all) => all.findIndex(e => e[0]===edge[0] && e[1]===edge[1]) === i) : [];
  const parts = [];
  parts.push(`This evidence review examines “${query}” using ${records.length} retrieved archive records. The records were returned by ${sources.length ? sources.join(', ') : 'the connected archive sources'}; the results should be treated as a searchable evidence sample, not a complete inventory of everything that ever existed about this subject.`);
  parts.push(`Image evidence: ${images.length} of ${records.length} records include an image URL${images.length ? `, including ${images.slice(0,5).map(r => r.title).join('; ')}${images.length>5 ? ', and other illustrated records' : ''}` : ''}. An image is a visual aid tied to the archive record; it does not independently prove every claim about an object's age, provenance, or interpretation. ${records.length-images.length} records have no image URL in the retrieved metadata.`);
  if (dated.length) parts.push(`Chronology: ${dated.length} records have a parseable year, ranging from ${dated[0].year} (${centuryLabel(dated[0].year)}) to ${dated[dated.length-1].year} (${centuryLabel(dated[dated.length-1].year)}). These are dates attached to individual records and may describe creation, discovery, accession, or another metadata date; they must not automatically be read as the start or end date of a civilization.`);
  else parts.push('Chronology: no records returned a usable year, so this result set cannot support a dated sequence without additional source research.');
  parts.push(`Geography: ${mapped.length} records include coordinates for mapping. ${countries.length ? `Country labels present in the metadata include ${countries.slice(0,12).join(', ')}${countries.length>12 ? ', and others' : ''}.` : 'No country labels were supplied in the returned records.'} A map point may represent a holding location or a place associated with a record; it is not necessarily the object's original findspot.`);
  parts.push(`Connection graph: the network contains ${G ? G.nodes.size : 0} nodes and ${edges.length} distinct links. ${graphParts && graphParts.length ? graphParts.join(' ') : ''} The graph is designed to show where matching or related catalogue entries were retrieved and which archive source, institution, or country metadata is associated with them. It is not a complete full-text concordance: links do not guarantee that the exact term appears verbatim in the full text of every report, and they do not prove direct influence, trade, conflict, or cultural descent.`);
  if (institutions.length) parts.push(`Collections and institutions represented include ${institutions.slice(0,15).join(', ')}${institutions.length>15 ? ', among others' : ''}. Institution labels can identify a current holder or provider rather than the original place where an object was created.`);
  if (context?.extract) parts.push(`Background context: ${context.extract}${context.url ? ` Context source: ${context.url}` : ''}`);
  parts.push(`Evidence limits: this summary is generated from the records and metadata returned for this search. Missing fields are not proof that an event or relationship did not occur. For disputed dates, provenance, or historical conclusions, consult each original linked source and compare independent scholarship.`);
  return { parts, images, dated, mapped, sources, institutions, countries, edges };
}

function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function csvCell(value) {
  const v = String(value ?? '');
  return '"' + v.replace(/"/g, '""') + '"';
}
function generateEvidenceCSV(records, G) {
  const rows = [['Title','Description','Year','Century','Institution / Collection','Country','Archive Source','Image URL','Record / Source URL','Latitude','Longitude','Graph connections']];
  records.forEach(r => {
    const connections = G ? G.edges.filter(([a,b]) => a===r.title || b===r.title || a===clip(r.title,40) || b===clip(r.title,40)).map(([a,b]) => a===r.title || a===clip(r.title,40) ? b : a) : [];
    rows.push([r.title,r.description,r.year ?? 'Unknown',centuryLabel(r.year),r.museum,r.country,r.source,r.image_url,r.source_url,r.lat ?? '',r.lon ?? '',[...new Set(connections)].join('; ')]);
  });
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
function generateHTMLReport(query, records, context, G, graphParts) {
  const deep = buildDeepSummary(query, records, context, G, graphParts);
  const title = esc(query.replace(/\b\w/g, c => c.toUpperCase()));
  const reportStyles = `body{margin:0;background:#f4ead9;color:#302923;font:15px/1.65 Arial,sans-serif}header,main,footer{max-width:1180px;margin:auto;padding:28px 24px}header{border-bottom:3px double #8b6a50}h1,h2,h3{font-family:Georgia,serif;line-height:1.2}h1{font-size:42px;margin:8px 0}h2{margin-top:34px;border-bottom:1px solid #b7a48b;padding-bottom:8px}p{max-width:90ch}.eyebrow{letter-spacing:.15em;text-transform:uppercase;font-size:11px;color:#8c3934}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:22px 0}.metric{padding:14px;border:1px solid #c6b49a;background:#fbf5eb}.metric b{display:block;font:28px Georgia}.summary{padding:18px 22px;background:#fbf5eb;border-left:4px solid #8c3934;margin:12px 0}.summary p{margin:0 0 12px}.summary p:last-child{margin:0}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12px;background:#fffaf1}th,td{text-align:left;vertical-align:top;padding:9px;border:1px solid #d7c7af;overflow-wrap:anywhere}th{background:#e4d2b8;position:sticky;top:0}tbody tr:nth-child(even){background:#f7eddd}td img{max-width:110px;max-height:90px;object-fit:contain}a{color:#8c3934}small{color:#6b5d4d}.connections li{margin:6px 0}.evidence-card{display:grid;grid-template-columns:140px 1fr;gap:16px;padding:14px 0;border-bottom:1px solid #d0bfa6}.evidence-card img{max-width:140px;max-height:120px;object-fit:contain}.pill{display:inline-block;background:#e6d5bb;padding:2px 8px;margin:2px;font-size:11px}@media(max-width:600px){header,main,footer{padding:18px 12px}.evidence-card{grid-template-columns:1fr}.evidence-card img{max-width:100%}}`;
  const metrics = [['Records',records.length],['With images',deep.images.length],['Dated records',deep.dated.length],['Mapped records',deep.mapped.length],['Graph nodes',G ? G.nodes.size : 0],['Graph links',deep.edges.length]];
  const summaryHTML = deep.parts.map(p => `<p>${esc(p)}</p>`).join('');
  const graphRows = deep.edges.map(([a,b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td><td>${esc(graphRelationship(a,G))}</td></tr>`).join('');
  const recordRows = records.map((r,i) => `<tr><td>${i+1}</td><td><strong>${esc(r.title)}</strong><br><small>${esc(r.description || 'No description supplied by source.')}</small></td><td>${esc(r.year ?? 'Unknown')}<br><small>${esc(centuryLabel(r.year))}</small></td><td>${esc(r.museum || 'Unknown')}</td><td>${esc(r.country || 'Not supplied')}</td><td>${esc(r.source || 'Unknown')}</td><td>${r.image_url ? `<a href="${esc(r.image_url)}" target="_blank" rel="noopener"><img src="${esc(r.image_url)}" alt="${esc(r.title)}"><br>Open image</a>` : 'No image URL'}</td><td>${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener">Open source ↗</a>` : 'No source URL'}</td><td>${Number.isFinite(r.lat) && Number.isFinite(r.lon) ? `${r.lat}, ${r.lon}` : 'Not supplied'}</td></tr>`).join('');
  const cards = deep.images.map(r => `<article class="evidence-card"><div><a href="${esc(r.image_url)}" target="_blank" rel="noopener"><img src="${esc(r.image_url)}" alt="${esc(r.title)}"></a></div><div><h3>${esc(r.title)}</h3><p>${esc(r.description || 'No description supplied by the archive.')}</p><p><span class="pill">${esc(r.source)}</span> <span class="pill">${esc(r.year ?? 'Date unknown')}</span> <span class="pill">${esc(r.museum)}</span></p>${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener">Original record ↗</a>` : ''}</div></article>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chronos Evidence Report — ${title}</title><style>${reportStyles}</style></head><body><header><div class="eyebrow">Chronos · Historical Evidence Explorer</div><h1>${title}</h1><p>Full evidence report · Generated ${new Date().toLocaleString()}</p><p><small>Evidence is reproduced from retrieved archive metadata. Interpretive limits and missing fields are stated explicitly.</small></p></header><main><h2>At a glance</h2><div class="metrics">${metrics.map(([k,v])=>`<div class="metric"><b>${v}</b>${esc(k)}</div>`).join('')}</div><h2>Deep summary</h2><div class="summary">${summaryHTML}</div>${context?.url ? `<p>Background reading: <a href="${esc(context.url)}" target="_blank" rel="noopener">${esc(context.title || 'Wikipedia context')}</a></p>` : ''}<h2>Retrieved image evidence</h2><p>${deep.images.length} records include image URLs. Images are linked to their original URLs; they may require an internet connection to display.</p>${cards || '<p>No images were returned for this search.</p>'}<h2>Graph connections</h2><p>The graph describes relationships present in the retrieved metadata, not proof of direct historical influence.</p><div class="table-wrap"><table><thead><tr><th>Node A</th><th>Node B</th><th>Relationship explanation</th></tr></thead><tbody>${graphRows || '<tr><td colspan="3">No graph links available.</td></tr>'}</tbody></table></div><h2>Full evidence table</h2><p>All ${records.length} retrieved records are included below. Use the source links to check original records.</p><div class="table-wrap"><table><thead><tr><th>#</th><th>Record & description</th><th>Date / era</th><th>Institution</th><th>Country</th><th>Archive</th><th>Image</th><th>Source link</th><th>Coordinates</th></tr></thead><tbody>${recordRows}</tbody></table></div><h2>Sources represented</h2><p>${deep.sources.map(s=>`<span class="pill">${esc(s)}</span>`).join(' ') || 'No source labels supplied.'}</p><h2>Reading this evidence responsibly</h2><p>Dates can refer to different stages in a record's history. A date attached to an object is not automatically a civilization's beginning or ending. Countries and institutions may indicate current custody or metadata associations rather than original provenance. Consult the linked source for precise dating, attribution, and provenance.</p></main><footer><small>Chronos · Historical Evidence Explorer · This report contains the complete retrieved result set for the current search.</small></footer></body></html>`;
}

/* ───────── read aloud (Web Speech API) ───────── */
const tts = {
  supported: "speechSynthesis" in window,
  stop() { if (this.supported) speechSynthesis.cancel(); },
  toggle(btn, str) {
    if (!this.supported) return;
    if (speechSynthesis.speaking) { speechSynthesis.cancel(); btn.textContent = "▶ Read aloud"; return; }
    const u = new SpeechSynthesisUtterance(str);
    u.lang = "en-US"; u.rate = 0.95;
    u.onend = u.onerror = () => (btn.textContent = "▶ Read aloud");
    btn.textContent = "■ Stop";
    speechSynthesis.speak(u);
  },
};

/* ───────── rendering ───────── */
const section = (n, label, title) => `
  <div class="pagenum">${String(n).padStart(2, "0")} / 12</div>
  <div class="arc-label">${esc(label)}</div>
  <h2 class="arc-title section">${esc(title)}</h2>`;
const rule = '<hr class="rule">';

function bars(entries) {
  const max = Math.max(...entries.map((e) => e[1]), 1);
  return entries.map(([n, v]) => `<div class="bar-row"><span class="name">${esc(n)}</span><span class="bar" style="width:${(v / max) * 55}%"></span><span class="val">${v}</span></div>`).join("");
}

function render() {
  const { query, records, context } = state;
  const app = $("#app");
  const sourcesAll = records.map((r) => r.source);
  const museumsAll = records.map((r) => r.museum).filter((m) => m && m !== "Unknown");
  const withImg = records.filter((r) => r.image_url), noImg = records.filter((r) => !r.image_url);
  const withCoords = records.filter((r) => r.lat && r.lon);
  const events = records.filter((r) => r.year !== null).sort((a, b) => a.year - b.year);
  const years = events.map((e) => e.year);
  const countries = [...new Set(records.map((r) => r.country).filter(Boolean))].sort();
  const titleCase = query.replace(/\b\w/g, (c) => c.toUpperCase());
  let h = "";

  // 02 — Wikipedia context + READ ALOUD
  if (context?.extract) {
    const th = safeUrl(context.thumbnail);
    h += section(2, "Editorial Introduction", "What the Record Shows");
    h += `<div class="context ${th ? "" : "no-thumb"}">`;
    if (th) h += `<div><div class="fig-frame"><img src="${esc(th)}" alt=""></div><div class="fig-caption"><b>Fig. 01</b> — Reference photograph, Wikimedia Commons.</div></div>`;
    h += `<div>${context.description ? `<div class="arc-label muted">${esc(context.description)}</div>` : ""}
      <p class="arc-intro wide">${esc(context.extract)}</p>
      <div class="read-row">
        ${tts.supported ? '<button class="btn red small" id="read-btn" type="button">▶ Read aloud</button>' : ""}
        <span class="source-badge">Wikipedia</span>
        ${safeUrl(context.url) ? `<a href="${esc(context.url)}" target="_blank" rel="noopener">Read the full article ↗</a>` : ""}
      </div></div></div>${rule}`;
  }

  // 03 — Index
  h += section(3, "Catalogue Summary", "Index of Findings");
  let ov = `Found <b>${records.length}</b> catalogued records concerning <b>${esc(titleCase)}</b>, drawn from ${new Set(sourcesAll).size} independent archives.`;
  if (years.length) ov += ` Records span from <b>${centuryLabel(Math.min(...years))}</b> to <b>${centuryLabel(Math.max(...years))}</b>.`;
  if (countries.length) ov += ` Geographic coverage includes ${esc(countries.slice(0, 8).join(", "))}.`;
  h += `<p class="arc-intro wide">${ov}</p>`;
  const metrics = [["Sources", new Set(sourcesAll).size], ["Records", records.length], ["Institutions", new Set(museumsAll).size],
    ["Illustrated", withImg.length], ["Dated Entries", events.length], ["Mapped Sites", withCoords.length]];
  h += `<div class="index-strip">${metrics.map(([l, n]) => `<div class="index-item"><div class="n">${String(n).padStart(2, "0")}</div><div class="l">${l}</div></div>`).join("")}</div>${rule}`;

  // 04 — Chronology
  h += section(4, "Sequence of Record", "Chronology");
  if (events.length) {
    h += `<div class="timeline-scroll">${renderTimeline(events)}</div><div id="timeline-detail" class="interaction-detail" aria-live="polite"><div class="detail-kicker">Choose a date</div><p>Select a year or event to see what this record tells us and open relevant historical context.</p></div>
      <details><summary>Examine all ${events.length} dated entries →</summary><div class="table-wrap"><table>
      <tr><th>Year</th><th>Title</th><th>Institution</th><th>Source</th></tr>
      ${events.map((e) => `<tr><td>${e.year}</td><td>${esc(clip(e.title, 60))}</td><td>${esc(e.museum)}</td><td>${esc(e.source)}</td></tr>`).join("")}
      </table></div></details>`;
  } else h += '<p class="arc-intro">No dated entries were found for this inquiry.</p>';
  h += rule;

  // 05 — Gallery
  h += section(5, "Material Evidence", "Gallery");
  const galleryRecords = [...withImg, ...noImg];
  const renderGalleryCard = (r, i) => {
    const fig = r.image_url
      ? `<button class="image-open" type="button" data-gallery-index="${i}" aria-label="View details for ${esc(r.title)}"><div class="fig-frame"><img loading="lazy" src="${esc(r.image_url)}" alt="${esc(r.title)}" data-fallback="${i + 1}" data-year="${esc(r.year ?? "")}"></div></button>`
      : placeholder(i + 1, r.year);
    const basic = r.description || `${r.title} is a catalogued historical record${r.year !== null ? ` dated to ${r.year}` : " with no confirmed date in this result"}. The entry was returned by ${r.source || "the archive"}${r.country ? ` and is associated with ${r.country}` : ""}.`;
    return `<article class="gallery-card">${fig}<div class="fig-caption"><b>${esc(r.title)}</b><br>${esc(r.museum)} · ${esc(centuryLabel(r.year))}</div><p class="image-info">${esc(clip(basic, 520))}</p>
      <div class="gallery-meta"><span>${esc(r.source || "Archive record")}</span>${r.year !== null ? `<span>${esc(r.year)}</span>` : ""}</div>
      ${r.source_url ? `<div class="arc-caption"><a href="${esc(r.source_url)}" target="_blank" rel="noopener">Source ↗</a></div>` : ""}</article>`;
  };
  const initialGalleryCount = Math.min(CFG.GALLERY_INITIAL, galleryRecords.length);
  h += `<div id="gallery-grid" class="gallery">${galleryRecords.slice(0, initialGalleryCount).map(renderGalleryCard).join("")}</div>`;
  if (galleryRecords.length > initialGalleryCount) h += `<div class="gallery-more-row"><span id="gallery-count">Showing ${initialGalleryCount} of ${galleryRecords.length} records</span><button id="gallery-more" class="btn" type="button">Load more records ↓</button></div>`;
  h += `<div id="image-detail" class="interaction-detail image-detail" aria-live="polite"></div>` + rule;

  // 06 — Cartography
  h += section(6, "Geographic Distribution", "Cartography");
  h += withCoords.length
    ? `<div id="map"></div><div class="fig-caption"><b>Fig.</b> — Findspots and holding institutions referenced in the record above.</div>`
    : '<p class="arc-intro">No geographic coordinates were recovered for this inquiry.</p>';
  h += rule;

  // 07 — Connections + SUMMARY
  const G = buildGraph(records, query);
  const sum = summarizeGraph(G, records, query);
  state.graphSummary = sum.join(" ");
  h += section(7, "Cross-References", "Connections");
  h += `<p class="arc-caption">Explore where matching or related catalogue entries are available. Source nodes identify the archive that returned a record; select any node for details. This is not a guaranteed word-for-word full-text index.</p><div id="graph"></div><div id="graph-detail" class="interaction-detail" aria-live="polite"><div class="detail-kicker">Explore the network</div><p>Select a node to inspect its record and the evidence behind its connections.</p></div>
    <div class="legend">${Object.entries(NODE_COLORS).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join("")}</div>
    <div class="graph-summary"><div class="arc-label muted">Graph Summary</div>${sum.map((p) => `<p>${esc(p)}</p>`).join("")}</div>`;
  const uMuseums = [...new Set(museumsAll)].slice(0, 2), uCountries = countries.slice(0, 2);
  const chain = [titleCase, ...uCountries, ...records.slice(0, 3).map((r) => clip(r.title, 25)), ...uMuseums];
  h += `<div style="margin-top:14px;line-height:2.4">${chain.map((c) => `<span class="chain-chip">${esc(c)}</span>`).join('<span class="chain-arrow">→</span>')}</div>${rule}`;

  // Deep evidence summary — combines retrieved records, image coverage, timeline, geography and graph relationships.
  const deep = buildDeepSummary(query, records, context, G, sum);
  h += section(8, "Integrated Evidence Review", "Deep Summary");
  h += `<div class="deep-summary"><div class="deep-summary-metrics">${[["Records",records.length],["Images",deep.images.length],["Dated",deep.dated.length],["Mapped",deep.mapped.length],["Graph links",deep.edges.length]].map(([label,value])=>`<div class="deep-metric"><span>${esc(label)}</span><b>${value}</b></div>`).join("")}</div><div class="deep-summary-copy">${deep.parts.map(p=>`<p>${esc(p)}</p>`).join("")}</div><div class="deep-summary-actions"><button class="btn red" id="dl-report-btn" type="button">Download Deep Evidence Report (.html)</button><button class="btn" id="dl-table-btn" type="button">Download Full Evidence Table (.csv)</button></div></div>${rule}`;

  // 09 — Statistics
  h += section(9, "Quantitative Summary", "Statistics");
  const count = (arr) => Object.entries(arr.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {}));
  const eras = count(events.map((e) => centuryLabel(e.year))).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  h += `<div class="charts"><div><div class="arc-label muted">Records per Source</div>${bars(count(sourcesAll))}</div>
    <div><div class="arc-label muted">Records by Era</div>${eras.length ? bars(eras) : '<p class="arc-intro">No era data available.</p>'}</div></div>${rule}`;

  // 09 — Corroboration
  h += section(10, "Reliability Assessment", "Corroboration");
  h += '<p class="arc-caption">Scores reflect only how many independent archives corroborate each record.</p>';
  h += records.slice(0, 12).map((r) => {
    const ms = [...new Set(records.filter((x) => x.title === r.title).map((x) => x.source))];
    const [st, label] = evidenceScore(ms);
    return `<div class="record-entry"><div class="title">${esc(clip(r.title, 70))}</div>
      <div class="stars">${"●".repeat(st)}${"○".repeat(5 - st)} <span class="meta">${label}</span></div>
      <div class="meta" style="margin-top:6px">Supported by: ${ms.map((s) => `<span class="source-badge">${esc(s)}</span>`).join("")}</div></div>`;
  }).join("") + rule;

  // 10 — Sources
  h += section(11, "Complete Bibliography", "Sources");
  h += `<details><summary>Examine the full evidence table →</summary><div class="table-wrap"><table>
    <tr><th>Title</th><th>Year</th><th>Institution</th><th>Country</th><th>Source</th><th>URL</th></tr>
    ${records.map((r) => `<tr><td>${esc(clip(r.title, 55))}</td><td>${r.year ?? ""}</td><td>${esc(clip(r.museum, 35))}</td><td>${esc(r.country)}</td><td>${esc(r.source)}</td>
      <td>${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener">link</a>` : ""}</td></tr>`).join("")}
    </table></div></details>
    <p class="arc-caption">The integrated summary above can be downloaded as a formatted report or a spreadsheet-ready evidence table.</p>`;

  // 12 — Assistant pointer
  h += `${rule}${section(12, "Ask Questions", "Ask the Archive")}
    <p class="arc-intro">Ask about these ${records.length} records — dates, institutions, countries, comparisons. Answers are based only on the evidence retrieved above.</p>
    <div style="margin-top:14px"><button class="btn" id="open-chat" type="button">Open the assistant →</button></div>`;

  app.innerHTML = h;
  app.querySelectorAll(".timeline-point, .timeline-label").forEach((el) => {
    const activate = () => showTimelineDetail(events[Number(el.dataset.eventIndex)]);
    el.addEventListener("click", activate);
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); activate(); } });
  });
  let galleryShown = initialGalleryCount;
  const galleryGrid = $("#gallery-grid");
  const galleryMore = $("#gallery-more");
  if (galleryMore && galleryGrid) galleryMore.addEventListener("click", () => {
    const next = Math.min(galleryShown + CFG.GALLERY_STEP, galleryRecords.length);
    galleryGrid.insertAdjacentHTML("beforeend", galleryRecords.slice(galleryShown, next).map((record, offset) => renderGalleryCard(record, galleryShown + offset)).join(""));
    galleryShown = next;
    const count = $("#gallery-count");
    if (count) count.textContent = `Showing ${galleryShown} of ${galleryRecords.length} records`;
    if (galleryShown >= galleryRecords.length) galleryMore.remove();
    wireGalleryCards();
    wireImageFallbacks();
  });
  const wireGalleryCards = () => app.querySelectorAll(".image-open:not([data-wired])").forEach((btn) => {
    btn.dataset.wired = "true";
    btn.addEventListener("click", () => showImageDetail(galleryRecords[Number(btn.dataset.galleryIndex)]));
  });
  const wireImageFallbacks = () => app.querySelectorAll("img[data-fallback]:not([data-fallback-wired])").forEach((img) => {
    img.dataset.fallbackWired = "true";
    img.onerror = () => { const frame = img.closest(".fig-frame"); if (frame) frame.outerHTML = placeholder(img.dataset.fallback, img.dataset.year); };
  });
  wireGalleryCards();

  // wire up
  const rb = $("#read-btn");
  if (rb) rb.onclick = () => tts.toggle(rb, [context.title, context.description, context.extract].filter(Boolean).join(". "));
  const safeFilename = query.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "historical_search";
  const reportBtn = $("#dl-report-btn");
  if (reportBtn) reportBtn.onclick = () => downloadBlob(`chronos_${safeFilename}_evidence_report.html`, generateHTMLReport(query, records, context, G, sum), "text/html;charset=utf-8");
  const tableBtn = $("#dl-table-btn");
  if (tableBtn) tableBtn.onclick = () => downloadBlob(`chronos_${safeFilename}_full_evidence.csv`, generateEvidenceCSV(records, G), "text/csv;charset=utf-8");
  $("#open-chat").onclick = openChat;
  wireImageFallbacks();
  renderGraph(G, $("#graph"));
  if (withCoords.length) drawMap(withCoords);
}

function showImageDetail(record) {
  const panel = $("#image-detail");
  if (!panel || !record) return;
  const basic = record.description || `${record.title} is a catalogued historical record${record.year !== null ? ` dated to ${record.year}` : " with no confirmed date in this result"}.`;
  panel.innerHTML = `<div class="detail-kicker">${esc(record.source || "Archive record")} · Image record</div><h3>${esc(record.title)}</h3>${record.image_url ? `<img class="detail-image" src="${esc(record.image_url)}" alt="${esc(record.title)}">` : ""}<p>${esc(basic)}</p><p class="detail-explain"><b>Date:</b> ${esc(record.year ?? "Not dated")} · <b>Collection:</b> ${esc(record.museum)} · <b>Country:</b> ${esc(record.country || "Not specified")}</p>${record.source_url ? `<a href="${esc(record.source_url)}" target="_blank" rel="noopener">Open original archive record ↗</a>` : ""}`;
  panel.classList.add("is-open");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function showTimelineDetail(record) {
  const panel = $("#timeline-detail");
  if (!panel || !record) return;
  panel.innerHTML = `<div class="detail-kicker">${esc(record.year)} · ${esc(centuryLabel(record.year))}</div><h3>${esc(record.title)}</h3><p>${esc(record.description || "No additional description was supplied by the source for this record.")}</p><p><b>Why this date appears:</b> The year comes from the archive record metadata; it is not automatically proof of when an entire civilization began or ended.</p><p class="detail-explain" id="year-context">Looking up related historical context…</p>${record.source_url ? `<a href="${esc(record.source_url)}" target="_blank" rel="noopener">Open source record ↗</a>` : ""}`;
  const contextEl = $("#year-context");
  if (record.year === null || record.year < 1) { if (contextEl) contextEl.textContent = "A broad year-based Wikipedia lookup is not available for this date format. Use the source record for precise context."; return; }
  const titles = await wikiSearch(`historical events ${record.year}`);
  const page = titles.length ? await wikiText(titles[0]) : null;
  if (contextEl) contextEl.textContent = page ? `Related context: ${clip(page.extract, 480)} Source: Wikipedia — ${page.title}.` : `No additional context was retrieved for ${record.year}. The selected record remains the primary evidence here.`;
}

function placeholder(n, year) {
  return `<div class="fig-placeholder"><div class="tag">Fig. ${String(n).padStart(2, "0")}</div><div class="desc">Archival Photograph</div>
    <div class="desc">Image Placeholder</div><div class="tag" style="color:var(--ink-soft)">${esc(year || "N.D.")}</div></div>`;
}

function drawMap(pts) {
  const map = L.map("map").setView([pts.reduce((s, p) => s + p.lat, 0) / pts.length, pts.reduce((s, p) => s + p.lon, 0) / pts.length], 3);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "© OpenStreetMap contributors © CARTO", maxZoom: 18,
  }).addTo(map);
  pts.forEach((r) => {
    const link = r.source_url ? `<br><a href="${esc(r.source_url)}" target="_blank" rel="noopener">View source</a>` : "";
    L.circleMarker([r.lat, r.lon], { radius: 6, color: COLORS.RED, weight: 1.4, fillColor: COLORS.RED, fillOpacity: 0.75 })
      .bindTooltip(clip(r.title, 40))
      .bindPopup(`<b>${esc(clip(r.title, 50))}</b><br>${esc(r.museum)}<br>${esc(r.year ?? "")}${link}`).addTo(map);
  });
}

/* ───────── chatbot (no AI, no keys): live Wikipedia retrieval + sentence extraction ───────── */
const STOP = new Set("a an the of in on at to for from by with and or but is are was were be been being did do does done what when where who whom whose which why how that this these those it its they them their there as about into than then so if can could would should will shall has have had not no yes tell me please give show know say said i you we he she his her".split(" "));
const FILLER = new Set("start started starts begin began begun end ended happen happened happens die died dies death deaths dead kill killed killing fight fought fighting win won lose lost many much date year time".split(" "));
const MONTHS = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const tokens = (s) => s.toLowerCase().match(/[a-z0-9]+/g) || [];

function intent(q) {
  const l = q.toLowerCase();
  return {
    when: /\bwhen\b|what (year|date)|\bstart|\bbegan|\bbegin|\bend(ed)?\b|\bdate\b/.test(l),
    who: /\bwho\b/.test(l),
    died: /\b(die|died|death|dead|kill|killed|casualt|fatalit|lives lost|victim)/.test(l),
    where: /\bwhere\b|\blocated\b|\blocation\b/.test(l),
    howMany: /how many|how much|number of/.test(l),
    why: /\bwhy\b|\bcause|\breason/.test(l),
    winner: /\bwon\b|\bwin\b|\bwinner|\bvictor|\boutcome|\bresult/.test(l),
  };
}

function sentences(extract) {
  const out = [];
  (extract || "").split("\n").forEach((line) => {
    line = line.trim();
    if (!line || line.startsWith("=")) return; // skip empty lines and "== Headings =="
    line.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).forEach((s) => {
      s = s.trim();
      if (s.length >= 25 && s.length <= 600) out.push(s);
    });
  });
  return out;
}

function scoreSentence(s, qTok, it, idx) {
  const st = new Set(tokens(s));
  let sc = 0;
  qTok.forEach((t) => { if (st.has(t)) sc += 2; });
  if (it.when && (MONTHS.test(s) || /\b\d{3,4}\b/.test(s))) sc += 3;
  if (it.died && /\b(died|killed|dead|death|casualt|fatalit|wounded|lost|slain|perished|executed|fell)/i.test(s)) sc += 4;
  if ((it.howMany || it.died) && /\d/.test(s)) sc += 2;
  if (it.who && /\b(commanded|led|king|emperor|general|duke|president|founded|ruled|army|forces)\b/i.test(s)) sc += 1;
  if (it.where && /\b(located|situated|near|south|north|east|west|modern-day|present-day)\b/i.test(s)) sc += 2;
  if (it.why && /\b(because|due to|caused|led to|reason|result of|following)\b/i.test(s)) sc += 3;
  if (it.winner && /\b(victory|defeated|won|decisive|surrender|outcome|victorious)/i.test(s)) sc += 3;
  if (idx < 8) sc += 1.6 - idx * 0.2; // slight preference for the article lead
  return sc;
}

async function wikiSearch(term) {
  const d = await getJSON(CFG.WIKI_ACTION, { action: "query", list: "search", srsearch: term, srlimit: 3, format: "json", origin: "*" });
  return (d?.query?.search || []).map((h) => h.title);
}

async function wikiText(title) {
  const d = await getJSON(CFG.WIKI_ACTION, {
    action: "query", prop: "extracts|info", explaintext: 1, redirects: 1, titles: title, inprop: "url", format: "json", origin: "*",
  });
  const p = d?.query?.pages ? Object.values(d.query.pages)[0] : null;
  return p && p.extract ? { title: p.title, extract: p.extract, url: p.fullurl || "" } : null;
}

async function wikiAnswer(q) {
  const it = intent(q);
  const qTok = tokens(q).filter((t) => !STOP.has(t));
  const kw = qTok.filter((t) => !FILLER.has(t));
  const pron = /\b(it|its|this|that|they|them|there|he|she|his|her)\b/i.test(q);
  const term = ((pron || kw.length < 2) && state.query ? state.query + " " : "") + kw.join(" ");
  const titles = await wikiSearch(term.trim() || q);
  if (!titles.length) return null;
  const pages = (await Promise.all(titles.map(wikiText))).filter(Boolean);
  const cand = [];
  pages.forEach((p, pi) => {
    const tt = new Set(tokens(p.title));
    const boost = kw.filter((t) => tt.has(t)).length * 3 - pi * 1.5;
    sentences(p.extract).forEach((s, i) => cand.push({ s, p, i, sc: scoreSentence(s, qTok, it, i) + boost }));
  });
  cand.sort((a, b) => b.sc - a.sc);
  if (!cand.length || cand[0].sc < 4) return null;
  const main = cand[0].p;
  const cut = Math.max(4, cand[0].sc * 0.7);
  const picks = cand.filter((c) => c.p === main && c.sc >= cut).slice(0, 3).sort((a, b) => a.i - b.i);
  return { text: picks.map((c) => c.s).join(" "), title: main.title, url: main.url };
}

function addMsg(role, txt, link) {
  const d = document.createElement("div");
  d.className = "msg " + role;
  d.textContent = txt;
  if (link && safeUrl(link.url)) {
    d.appendChild(document.createElement("br"));
    const a = document.createElement("a");
    a.href = link.url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = `Source: Wikipedia — ${link.title} ↗`;
    a.style.cssText = "font:11px 'IBM Plex Sans',sans-serif";
    d.appendChild(a);
  }
  const log = $("#chat-log");
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

function openChat() {
  $("#chat-panel").classList.remove("hidden");
  $("#chat-fab").classList.add("hidden");
  $("#chat-input").focus();
}
function closeChat() {
  $("#chat-panel").classList.add("hidden");
  $("#chat-fab").classList.remove("hidden");
}

function resetChat() {
  $("#chat-log").innerHTML = "";
  $("#chat-sub").textContent = `Answers fetched live from Wikipedia · topic: ${state.query}`;
  addMsg("bot", `Ask me about “${state.query}” — for example when it started, who was involved, or who died. I look the answer up on Wikipedia and show you the source. I can also answer questions about the ${state.records.length} records on this page.`);
  const sugg = [`What is ${state.query}?`, `When did ${state.query} begin?`, `Where was ${state.query}?`, "Which is the earliest record?"];
  $("#chat-chips").innerHTML = sugg.map((s) => `<button type="button">${esc(s)}</button>`).join("");
  $("#chat-chips").querySelectorAll("button").forEach((b) => (b.onclick = () => ask(b.textContent)));
  $("#chat-fab").classList.remove("hidden");
  $("#chat-panel").classList.add("hidden");
}

/* Answers computed directly from the records on this page. */
function localAnswer(q) {
  const R = state.records, ql = q.toLowerCase();
  const dated = R.filter((r) => r.year !== null).sort((a, b) => a.year - b.year);
  const fmt = (r) => `“${clip(r.title, 70)}” (${r.year ?? "undated"}, ${r.museum}${r.country ? ", " + r.country : ""})`;
  if (/earliest|oldest|first/.test(ql) && dated.length) return `The earliest dated record is ${fmt(dated[0])}.`;
  if (/latest|newest|most recent/.test(ql) && dated.length) return `The latest dated record is ${fmt(dated.at(-1))}.`;
  if (/how many|number|count/.test(ql)) return `There are ${R.length} records from ${new Set(R.map((r) => r.source)).size} sources; ${dated.length} have dates and ${R.filter((r) => r.image_url).length} have images.`;
  if (/museum|institution|collection|held|hold/.test(ql)) {
    const m = [...new Set(R.map((r) => r.museum).filter((x) => x !== "Unknown"))].slice(0, 12);
    return m.length ? `Institutions in these records: ${m.join("; ")}.` : "No institutions were named in these records.";
  }
  if (/countr|where|place|located/.test(ql)) {
    const c = [...new Set(R.map((r) => r.country).filter(Boolean))];
    return c.length ? `Countries that appear in the records: ${c.join(", ")}.` : "No countries were recorded.";
  }
  const toks = tokens(ql).filter((t) => t.length > 3 && !STOP.has(t));
  const scored = R.map((r) => {
    const hay = `${r.title} ${r.museum} ${r.country} ${r.description}`.toLowerCase();
    return [toks.filter((t) => hay.includes(t)).length, r];
  }).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 4);
  return scored.length ? "Closest matching records:\n" + scored.map(([, r]) => "• " + fmt(r)).join("\n") : null;
}

async function ask(question) {
  question = question.trim();
  if (!question) return;
  $("#chat-chips").innerHTML = "";
  addMsg("user", question);
  const pending = addMsg("bot", "Searching Wikipedia…");
  const btn = $("#chat-form button");
  btn.disabled = true;
  try {
    const aboutRecords = /\b(records?|results?|objects?|artifacts?|archive)\b|\b(museums?|institutions?)\b.*\b(hold|held|these|here)\b|\bcountries appear\b/i.test(question);
    let ans = null;
    if (aboutRecords) {
      const t = localAnswer(question);
      if (t) ans = { text: t };
    }
    if (!ans) {
      const w = await wikiAnswer(question);
      if (w) ans = w;
    }
    if (!ans) {
      const t = localAnswer(question);
      ans = { text: t || "I couldn't find a clear answer on Wikipedia. Try rephrasing with the name of the person, place or event." };
    }
    pending.remove();
    addMsg("bot", ans.text, ans.url ? ans : null);
  } catch (e) {
    console.warn(e);
    pending.textContent = "Something went wrong reaching Wikipedia. Please try again.";
  } finally {
    btn.disabled = false;
    $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  }
}

/* ───────── search flow ───────── */
async function search(q) {
  q = q.trim();
  if (!q) return;
  tts.stop();
  const go = $("#go");
  go.disabled = true;
  $("#app").innerHTML = '<div class="loading">Retrieving historical evidence…</div>';
  $("#chat-fab").classList.add("hidden");
  $("#chat-panel").classList.add("hidden");
  try {
    const [raw, context] = await Promise.all([fetchAll(q), fetchWikipediaSummary(q).catch(() => null)]);
    const records = dedupe(raw.map(normalize));
    if (!records.length) {
      $("#app").innerHTML = `<div class="empty-state"><div class="mark">No records found in the archive.</div>
        <div class="sub">Try a broader inquiry.</div></div>`;
      return;
    }
    Object.assign(state, { query: q, records, context });
    render();
    resetChat();
    history.replaceState(null, "", "?q=" + encodeURIComponent(q));
  } catch (e) {
    console.error(e);
    $("#app").innerHTML = `<div class="empty-state"><div class="mark">Something went wrong.</div><div class="sub">Please try again.</div></div>`;
  } finally {
    go.disabled = false;
  }
}

$("#search-form").addEventListener("submit", (e) => { e.preventDefault(); search($("#q").value); });
$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const i = $("#chat-input"), v = i.value;
  i.value = "";
  ask(v);
});
$("#chat-fab").onclick = openChat;
$("#chat-close").onclick = closeChat;

const initial = new URLSearchParams(location.search).get("q");
if (initial) { $("#q").value = initial; search(initial); }
