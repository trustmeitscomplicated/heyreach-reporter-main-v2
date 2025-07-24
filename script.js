// ============================================================================
// HeyReach Dashboard — script.js (FINALNA WERSJA Z POPRAWIONYM API)
// ----------------------------------------------------------------------------
// ZINTEGROWANE ZMIANY:
// - Zaimplementowano poprawną logikę wyświetlania PEŁNEJ historii
//   konwersacji na podstawie dostarczonej dokumentacji.
// - Usunięto zbędne wywołania API, co znacznie optymalizuje działanie.
// - Aplikacja jest teraz w pełni funkcjonalna.
// ============================================================================

/* global Chart, jsPDF */

// ---------- Konfiguracja ----------------------------------------------------
const PROXY_URL = "https://corsproxy.io/?";
const API_URL = "https://api.heyreach.io/api/public";
const BASE_URL = PROXY_URL + API_URL;

const ENDPOINTS = {
  campaign: "/campaign/GetAll",
  conversations: "/inbox/GetConversationsV2",
  // Usunięto niepotrzebny endpoint
};
const PAGE_LIMIT = 100;

// ---------- Stan -----------------------------------------------------------
let apiKeys = [];
let campaigns = [];
let chartInstance = null;
let sortAsc = true;
// Zmienna do przechowywania konwersacji dla aktywnego modala
let activeModalConversations = [];

// ---------- Helpers DOM ----------------------------------------------------
const qs = (s, p = document) => p.querySelector(s);
const qsa = (s, p = document) => [...p.querySelectorAll(s)];

function themeInit() {
  const btn = qs("#theme-toggle");
  const sun = qs("#theme-icon-sun");
  const moon = qs("#theme-icon-moon");
  const stored = localStorage.getItem("hr-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (stored === "dark" || (!stored && prefersDark)) {
    document.documentElement.classList.add("dark");
    if (sun) sun.classList.remove("hidden");
  } else {
    if (moon) moon.classList.remove("hidden");
  }
  btn.addEventListener("click", () => {
    const dark = document.documentElement.classList.toggle("dark");
    if (sun) sun.classList.toggle("hidden", !dark);
    if (moon) moon.classList.toggle("hidden", dark);
    localStorage.setItem("hr-theme", dark ? "dark" : "light");
  });
}

// ---------- Pipeline -------------------------------------------------------
async function onFetchData() {
  try {
    resetUI();
    apiKeys = [qs("#api-key-1").value, qs("#api-key-2").value, qs("#api-key-3").value].map((v) => v.trim()).filter(Boolean);
    if (!apiKeys.length) throw new Error("Podaj co najmniej jeden klucz API.");

    setStatus("Pobieram kampanie…", true);
    const allLists = await Promise.all(apiKeys.map((key, idx) => fetchCampaigns(key, idx)));
    campaigns = allLists.flat();
    if (!campaigns.length) throw new Error("Brak kampanii lub błąd klucza API. Sprawdź poprawność kluczy i odśwież stronę.");

    setStatus("Liczenie odpowiedzi…", true);
    await Promise.all(campaigns.map((c) => fetchRepliesForCampaign(c)));

    renderAll();
    setStatus("Gotowe!", false);
  } catch (e) {
    console.error(e);
    setStatus(e.message || "Wystąpił nieoczekiwany błąd.", false, true);
  }
}

// ---------- API core -------------------------------------------------------
async function apiPost(apiKey, endpoint, body = {}, retries = 3, delay = 1000) {
  try {
    const res = await fetch(BASE_URL + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify(body),
    });

    if (res.status === 429 && retries > 0) {
      setStatus(`API przeciążone. Ponawiam za ${delay / 1000}s...`, true);
      await new Promise((r) => setTimeout(r, delay));
      return apiPost(apiKey, endpoint, body, retries - 1, delay * 2);
    }

    if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const errorMsg = errData.error || errData.message || "Nieznany błąd serwera";
        throw new Error(`Błąd zapytania do ${endpoint} (status: ${res.status}) — ${errorMsg}`);
    }

    return res.json();
  } catch (e) {
    throw e;
  }
}

async function paginate(apiKey, endpoint, body) {
  let offset = 0;
  const out = [];
  while (true) {
    const resp = await apiPost(apiKey, endpoint, { ...body, limit: PAGE_LIMIT, offset });
    const items = resp.items || [];
    out.push(...items);
    if (items.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }
  return out;
}

// ---------- Logika Aplikacji -----------------------------------------------
async function fetchCampaigns(apiKey, keyIdx) {
  const list = await paginate(apiKey, ENDPOINTS.campaign, {});
  return list.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    progressStats: c.progressStats || {},
    totalLeads: (c.progressStats?.totalUsers) || 0,
    linkedInAccountId: c.linkedInAccountId ?? c.accountId ?? null,
    accountName: c.accountName ?? "(brak nazwy konta)",
    sourceKeyIdx: keyIdx,
    numReplies: 0,
    replyRate: "0%",
  }));
}

async function fetchRepliesForCampaign(c) {
  const apiKey = apiKeys[c.sourceKeyIdx];
  const filters = {
    campaignIds: [c.id],
    linkedInAccountIds: c.linkedInAccountId ? [c.linkedInAccountId] : []
  };

  const convos = await paginate(apiKey, ENDPOINTS.conversations, { filters });
  
  // POPRAWKA: Zliczamy konwersacje, które mają jakąkolwiek wiadomość od "CORRESPONDENT"
  c.numReplies = convos.filter(cv => cv.messages && cv.messages.some(m => m.sender === 'CORRESPONDENT')).length;
  c.replyRate = c.totalLeads ? `${((c.numReplies / c.totalLeads) * 100).toFixed(1)}%` : "0%";
}

// ---------- UI -------------------------------------------------------------
function setStatus(msg, loading, error = false) {
  qs("#status-message").textContent = msg;
  qs("#loader").classList.toggle("hidden", !loading);
  qs("#status-message").classList.toggle("text-red-600", error);
  qs("#status-message").classList.toggle("text-green-600", !error && !loading && msg === 'Gotowe!');
}

function resetUI() {
  campaigns = [];
  qs("#results-section").classList.add("hidden");
  qs("#summary-grid").innerHTML = "";
  qs("#campaigns-table tbody").innerHTML = "";
  if (chartInstance) chartInstance.destroy();
}

function renderAll() {
  qs("#results-section").classList.remove("hidden");
  populateFilters();
  drawSummaryCards();
  drawStatusChart();
  refreshTable();
}

function populateFilters() {
    const accSel = qs("#filter-account");
    if (!accSel) return;
    const uniqueAccounts = [...new Map(campaigns.map(c => [c.linkedInAccountId, c.accountName])).entries()];
    
    accSel.innerHTML = '<option value="">Wszystkie konta</option>' +
      uniqueAccounts
        .sort(([, aName], [, bName]) => aName.localeCompare(bName))
        .map(([id, name]) => `<option value="${id}">${name}</option>`).join("");
    
    accSel.addEventListener("change", refreshTable);

    const wrapper = qs("#status-filters .space-y-2");
    wrapper.innerHTML = "";
    [...new Set(campaigns.map(c => c.status))].sort().forEach(st => {
        const id = `chk-${st}`;
        wrapper.insertAdjacentHTML("beforeend", `<label class="flex items-center space-x-2 cursor-pointer"><input type="checkbox" id="${id}" data-val="${st}" checked class="accent-primary h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"><span>${st}</span></label>`);
        qs(`#${id}`).addEventListener("change", refreshTable);
    });
}


function applyFiltersSort(list) {
  const accId = qs("#filter-account").value;
  const allowedStatuses = qsa("#status-filters input:checked").map(c => c.dataset.val);
  
  let arr = list;
  if (accId) {
    arr = arr.filter(c => String(c.linkedInAccountId) === accId);
  }
  arr = arr.filter(c => allowedStatuses.includes(c.status));

  const sortBy = qs("#sort-by").value;
  arr.sort((a, b) => {
    let A = a[sortBy];
    let B = b[sortBy];
    if (typeof A === 'string') A = A.toLowerCase();
    if (typeof B === 'string') B = B.toLowerCase();
    if (A < B) return sortAsc ? -1 : 1;
    if (A > B) return sortAsc ? 1 : -1;
    return 0;
  });
  return arr;
}

function drawSummaryCards() {
    const grid = qs("#summary-grid");
    grid.innerHTML = "";
    
    const stats = { total: 0, inProgress: 0, pending: 0, finished: 0, failed: 0, excluded: 0 };
    campaigns.forEach(c => {
        stats.total += c.progressStats.totalUsers || 0;
        stats.inProgress += c.progressStats.totalUsersInProgress || 0;
        stats.pending += c.progressStats.totalUsersPending || 0;
        stats.finished += c.progressStats.totalUsersFinished || 0;
        stats.failed += c.progressStats.totalUsersFailed || 0;
        stats.excluded += c.progressStats.totalUsersExcluded || 0;
    });

    const totalReplies = campaigns.reduce((s, c) => s + c.numReplies, 0);
    const rate = stats.total > 0 ? ((totalReplies / stats.total) * 100).toFixed(1) + "%" : "0%";

    const cards = [
        { t: "Total Leads", v: stats.total },
        { t: "In Progress", v: stats.inProgress },
        { t: "Pending", v: stats.pending },
        { t: "Finished", v: stats.finished },
        { t: "Failed", v: stats.failed },
        { t: "Excluded", v: stats.excluded },
        { t: "Odpowiedzi", v: `${totalReplies} (${rate})` },
    ];
    cards.forEach(o => {
        grid.insertAdjacentHTML("beforeend", `<div class="p-6 rounded-xl bg-surface dark:bg-surface-dark shadow-subtle border border-border dark:border-border-dark text-center"><p class="text-sm text-text-muted dark:text-text-muted-dark mb-1">${o.t}</p><p class="text-3xl font-bold">${o.v}</p></div>`);
    });
}


function drawStatusChart() {
  const ctx = qs("#status-chart").getContext("2d");
  const tally = {};
  campaigns.forEach((c) => tally[c.status] = (tally[c.status] || 0) + 1);
  const data = { labels: Object.keys(tally), datasets: [{ data: Object.values(tally) }] };
  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart(ctx, { type: "doughnut", data, options: { plugins: { legend: { position: "bottom" } } } });
}

function refreshTable() {
  const tbody = qs("#campaigns-table tbody");
  tbody.innerHTML = "";
  applyFiltersSort([...campaigns]).forEach((c) => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-colors duration-150";
    tr.innerHTML = `<td class="p-4 font-medium">${c.name}</td><td class="p-4">${c.accountName}</td><td class="p-4">${c.status}</td><td class="p-4 text-center">${c.totalLeads}</td><td class="p-4 text-center">${c.numReplies}</td><td class="p-4 text-center font-semibold">${c.replyRate}</td>`;
    tr.addEventListener("click", () => openModal(c));
    tbody.appendChild(tr);
  });
}

async function openModal(c) {
  const dlg = qs("#leads-modal");
  dlg.showModal();
  qs("#modal-title").textContent = `Konwersacje: ${c.name}`;
  qs("#modal-loader").classList.remove("hidden");
  qs("#modal-content-container").classList.add('hidden');
  qs("#conversations-list").innerHTML = qs("#messages-thread").innerHTML = "";

  try {
    const apiKey = apiKeys[c.sourceKeyIdx];
    const convos = await paginate(apiKey, ENDPOINTS.conversations, {
      filters: {
        campaignIds: [c.id],
        linkedInAccountIds: c.linkedInAccountId ? [c.linkedInAccountId] : [],
      },
    });
    
    qs("#modal-content-container").classList.remove('hidden');

    // POPRAWKA: Filtrujemy po wiadomościach od "CORRESPONDENT"
    activeModalConversations = convos.filter(c => c.messages && c.messages.some(m => m.sender === 'CORRESPONDENT'));

    if (!activeModalConversations.length) {
      qs("#conversations-list").innerHTML = '<p class="p-4 text-sm text-text-muted dark:text-text-muted-dark">Brak konwersacji z odpowiedziami w tej kampanii.</p>';
      qs("#messages-thread").innerHTML = '';
      return;
    }
    
    qs("#conversations-list").innerHTML = ''; // Wyczyść listę przed dodaniem nowych
    activeModalConversations.forEach((v, i) => {
      const div = document.createElement("div");
      div.className = "p-4 border-b border-border dark:border-border-dark hover:bg-gray-100 dark:hover:bg-gray-800/50 cursor-pointer transition-colors duration-150";
      div.dataset.convoId = v.id;
      div.innerHTML = `<p class="font-medium truncate">${v.correspondentProfile.firstName} ${v.correspondentProfile.lastName}</p><p class="text-xs text-text-muted dark:text-text-muted-dark truncate">${v.lastMessageText ?? 'Brak ostatniej wiadomości'}</p>`;
      div.addEventListener("click", (e) => {
          qsa('#conversations-list > div').forEach(el => el.classList.remove('bg-gray-100', 'dark:bg-gray-800/50'));
          e.currentTarget.classList.add('bg-gray-100', 'dark:bg-gray-800/50');
          displayMessages(v.id);
      });
      qs("#conversations-list").appendChild(div);
    });
    
    // Automatycznie załaduj pierwszą konwersację z listy
    if (activeModalConversations.length > 0) {
        const firstConvo = activeModalConversations[0];
        qs('#conversations-list > div:first-child').classList.add('bg-gray-100', 'dark:bg-gray-800/50');
        displayMessages(firstConvo.id);
    }

  } catch (e) {
    qs("#conversations-list").innerHTML = `<p class="p-4 text-red-600 text-sm">${e.message}</p>`;
  } finally {
    qs("#modal-loader").classList.add("hidden");
  }
}

function displayMessages(convoId) {
  const thread = qs("#messages-thread");
  thread.innerHTML = "";
  
  const convo = activeModalConversations.find(c => c.id === convoId);
  if (!convo || !convo.messages) {
    thread.innerHTML = `<p class="p-4 text-text-muted dark:text-text-muted-dark">Nie znaleziono wiadomości dla tej konwersacji.</p>`;
    return;
  }

  (convo.messages || []).forEach((m) => {
    const incoming = m.sender === "CORRESPONDENT";
    const div = document.createElement("div");
    div.className = `flex flex-col ${incoming ? 'items-start' : 'items-end'}`;
    div.innerHTML = `<div class="message-bubble ${incoming ? "message-received" : "message-sent"}">
      <p class="whitespace-pre-wrap">${escapeHTML(m.body || "(bez treści)")}</p>
      <span class="block mt-1 text-xs opacity-70 text-right">${new Date(m.createdAt).toLocaleString('pl-PL')}</span>
    </div>`;
    thread.appendChild(div);
  });
  thread.scrollTop = thread.scrollHeight;
}


function escapeHTML(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- Inicjalizacja --------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  // Inicjalizacja motywu i przycisków
  if (qs("#theme-toggle")) themeInit();
  if (qs("#fetch-data-btn")) qs("#fetch-data-btn").addEventListener("click", onFetchData);
  if (qs("#sort-by")) qs("#sort-by").addEventListener("change", refreshTable);
  if (qs("#sort-dir-btn")) qs("#sort-dir-btn").addEventListener("click", () => {
    sortAsc = !sortAsc;
    qs("#sort-dir-btn svg").classList.toggle("rotate-180", !sortAsc);
    refreshTable();
  });
  if (qs("#modal-close-btn")) qs("#modal-close-btn").addEventListener("click", () => qs("#leads-modal").close());
  
  // Przeniesienie logiki z `index.html` dla czystości
  const savedKey = localStorage.getItem('heyreach_api_key');
  if (savedKey) {
      qs('#api-key-1').value = savedKey; // Zakładamy, że klucz jest w pierwszym polu
      onFetchData();
  }
});
