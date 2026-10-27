import { CreateMLCEngine, prebuiltAppConfig } from "@mlc-ai/web-llm";

const $ = (id) => document.getElementById(id);

// ---------- Montandon (STAC) ----------

// With MONTANDON_TOKEN in .env, the dev server proxies /stac and adds the token. Otherwise
// (no .env token, or the static build) we call Montandon directly with a token the user enters.
const USE_PROXY = __HAS_ENV_TOKEN__;
const STAC_URL = USE_PROXY ? "/stac" : "https://montandon-eoapi.ifrc.org/stac";
const tokenInput = $("token");
try { tokenInput.value = localStorage.getItem("montandon-token") || ""; } catch {}

const askForToken = () => $("token-dialog").showModal();
$("token-dialog").onclose = () => {
  try { localStorage.setItem("montandon-token", tokenInput.value.trim()); } catch {}
  init();
};
$("change-token").hidden = USE_PROXY;
$("change-token").onclick = askForToken;

function init() {
  loadCollections().catch((e) => {
    $("data-status").textContent = `Montandon: ${e.message}`;
    if (!USE_PROXY && /^40[13]/.test(e.message)) askForToken();
  });
}

async function stac(path, body) {
  const headers = { "Content-Type": "application/json" };
  if (!USE_PROXY) headers.Authorization = `Bearer ${tokenInput.value.trim()}`;
  const res = await fetch(`${STAC_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function loadCollections() {
  const { collections } = await stac("/collections");
  const ids = collections.map((c) => c.id).sort();
  $("collection").innerHTML = ids
    .filter((id) => id.endsWith("-events"))
    .map((id) => `<option>${id}</option>`)
    .join("");
}

async function searchEvents() {
  $("data-status").textContent = "Searching…";
  const from = $("from").value, to = $("to").value;
  const { features } = await stac("/search", {
    collections: [$("collection").value],
    datetime: `${from ? `${from}T00:00:00Z` : ".."}/${to ? `${to}T23:59:59Z` : ".."}`,
    sortby: [{ field: "datetime", direction: "desc" }],
    limit: 100,
  });
  const q = $("title").value.toLowerCase();
  const items = features.filter((f) => (f.properties.title || f.id).toLowerCase().includes(q));
  $("data-status").textContent = `${items.length} events`;
  $("events").innerHTML = "";
  for (const f of items) {
    const li = document.createElement("li");
    li.textContent = `${f.properties.datetime?.slice(0, 10)} — ${f.properties.title || f.id}`;
    li.onclick = () => loadEvent(f);
    $("events").append(li);
  }
}

// Any item id works (event, hazard or impact) since everything is linked through monty:corr_id.
async function loadById(id) {
  const { features } = await stac("/search", { ids: [id] });
  if (!features.length) throw new Error(`No item with id ${id}`);
  resetChat();
  await loadEvent(features[0]);
}

// Fetch every item (event, hazards, impacts from all sources) sharing the event's correlation id.
async function loadEvent(event) {
  const corrId = event.properties["monty:corr_id"];
  $("data-status").textContent = `Loading items for ${corrId}…`;
  const items = [];
  let body = {
    filter: { op: "=", args: [{ property: "monty:corr_id" }, corrId] },
    "filter-lang": "cql2-json",
    limit: 200,
  };
  // Follow pagination
  while (body) {
    const page = await stac("/search", body);
    items.push(...page.features);
    const next = page.links?.find((l) => l.rel === "next");
    body = next?.body ?? null;
  }
  $("data-status").textContent = `${items.length} related items for ${corrId}`;
  $("context").value = toContext(event, items);
}

// Turn STAC items into compact text a small model can read.
function toContext(event, items) {
  const p = event.properties;
  const lines = [
    `EVENT: ${p.title || event.id}`,
    `Correlation ID: ${p["monty:corr_id"]}`,
    `Dates: ${p.start_datetime || p.datetime} to ${p.end_datetime || p.datetime}`,
    `Countries (ISO3): ${(p["monty:country_codes"] || []).join(", ")}`,
    `Hazard codes: ${(p["monty:hazard_codes"] || []).join(", ")}`,
  ];
  if (p.description) lines.push(`Description: ${p.description.slice(0, 600)}`);

  const hazards = items.filter((i) => i.properties["monty:hazard_detail"]);
  if (hazards.length) {
    lines.push("", "HAZARDS:");
    for (const h of hazards) {
      const d = h.properties["monty:hazard_detail"];
      const sev = [d.severity_value, d.severity_unit, d.severity_label].filter((x) => x != null).join(" ");
      lines.push(`- [${h.collection}] ${h.properties.datetime?.slice(0, 10)} ${d.cluster || ""} severity: ${sev || "n/a"}`);
    }
  }

  // Impact reports overlap (country vs. province) and repeat, so list them rather than sum them.
  const impacts = items.filter((i) => i.properties["monty:impact_detail"]);
  if (impacts.length) {
    const byType = {};
    for (const i of impacts) {
      const d = i.properties["monty:impact_detail"];
      const key = `[${i.collection}] ${d.category} ${d.type}`;
      const text = i.properties.description || `${d.value} ${d.unit || ""}`;
      (byType[key] ??= new Set()).add(text);
    }
    lines.push("", "IMPACT REPORTS (regions may overlap; do not add them up):");
    for (const [k, texts] of Object.entries(byType)) {
      lines.push(`${k}:`);
      for (const t of texts) lines.push(`  - ${t}`);
    }
  }

  const others = items.filter((i) => i.id !== event.id && i.collection.endsWith("-events"));
  if (others.length) {
    lines.push("", "SAME EVENT IN OTHER SOURCES:");
    for (const o of others) lines.push(`- [${o.collection}] ${o.properties.title || o.id}`);
  }
  return lines.join("\n");
}

// ---------- WebLLM ----------

let engine;
const history = [];

// Small instruct models only.
const models = prebuiltAppConfig.model_list
  .map((m) => m.model_id)
  .filter((id) => /(Qwen2\.5|Qwen3|Llama-3\.2|Phi-3\.5|SmolLM2|gemma-2)/.test(id) && /q4f16/.test(id))
  .filter((id) => !/(vision|Coder|Math|jpn|-1k|7B|8B|9B)/.test(id));
$("model").innerHTML = models.map((id) => `<option>${id}</option>`).join("");
$("model").value = models.find((id) => id.startsWith("Qwen2.5-1.5B-Instruct")) || models[0];

$("load").onclick = async () => {
  $("load").disabled = true;
  engine = await CreateMLCEngine($("model").value, {
    initProgressCallback: (r) => ($("model-status").textContent = r.text),
  }, { context_window_size: 8192 });
  $("question").disabled = $("ask").querySelector("button").disabled = false;
  $("load").disabled = false;
};

$("ask").onsubmit = async (e) => {
  e.preventDefault();
  const question = $("question").value.trim();
  if (!question) return;
  $("question").value = "";

  const userEl = Object.assign(document.createElement("div"), { className: "user", textContent: question });
  const answerEl = document.createElement("div");
  $("chat").append(userEl, answerEl);

  history.push({ role: "user", content: question });
  const messages = [
    {
      role: "system",
      content:
        "You answer questions about a disaster event using ONLY the data below, from the Montandon Global Crisis Data Bank. " +
        "If the answer is not in the data, say so. Cite the source collection for numbers.\n\n" + $("context").value,
    },
    ...history,
  ];

  let answer = "";
  const t0 = performance.now();
  const stream = await engine.chat.completions.create({ messages, stream: true, temperature: 0.2 });
  for await (const chunk of stream) {
    answer += chunk.choices[0]?.delta?.content || "";
    answerEl.textContent = answer;
    $("chat").scrollTop = $("chat").scrollHeight;
  }
  history.push({ role: "assistant", content: answer });
  $("model-status").textContent = `Answered in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
};

// Clearing chat history when a new event is loaded keeps answers grounded in the current context.
function resetChat() {
  history.length = 0;
  $("chat").innerHTML = "";
}
$("events").addEventListener("click", resetChat);
$("by-id").onsubmit = (e) => {
  e.preventDefault();
  loadById($("item-id").value.trim()).catch((e) => ($("data-status").textContent = e.message));
};
$("search").onclick = () => searchEvents().catch((e) => ($("data-status").textContent = e.message));
if (!USE_PROXY && !tokenInput.value) askForToken();
else init();
