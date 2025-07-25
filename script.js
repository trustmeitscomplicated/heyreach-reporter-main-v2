// ============================================================================
// HeyReach Dashboard — script.js (VERSION 11 - DEPENDENT FILTERS FIX)
// ----------------------------------------------------------------------------
// INTEGRATED FIXES:
// - Fixed the campaign filter logic. It now updates based on the selected account.
// - This prevents selecting impossible filter combinations and ensures correct behavior.
// - Maintained all previous functionality and visual improvements.
// ============================================================================

/* global Chart */

// ---------- Configuration ----------------------------------------------------
const BASE_URL = "https://shy-meadow-dba0.lammelstanislaw.workers.dev/api/public";
const PAGE_LIMIT = 100;

const ENDPOINTS = {
  accounts: "/li_account/GetAll",
  campaigns: "/campaign/GetAll",
  conversations: "/inbox/GetConversationsV2",
};

// Consistent color mapping for statuses
const STATUS_COLORS = {
    'IN_PROGRESS': 'hsl(217, 91%, 60%)', // Blue
    'FINISHED': 'hsl(145, 63%, 42%)',    // Green
    'PAUSED': 'hsl(38, 92%, 50%)',      // Yellow/Orange
    'DRAFT': 'hsl(215, 14%, 34%)',      // Grey
    'FAILED': 'hsl(354, 70%, 54%)',     // Red
    'default': 'hsl(215, 16%, 65%)'     // Default Grey
};

// ---------- State -----------------------------------------------------------
let apiKeys = [];
let allCampaigns = [];
let allAccounts = [];
let chartInstance = null;
let sortAsc = true;
let activeModalConversations = [];

// ---------- DOM Helpers ----------------------------------------------------
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
    if (!apiKeys.length) throw new Error("Please provide at least one API key.");

    setStatus("Fetching LinkedIn accounts…", true);
    allAccounts = await fetchAllAccounts(apiKeys);
    const accountsMap = new Map(allAccounts.map(acc => [acc.id, acc]));

    setStatus("Fetching campaigns…", true);
    const campaignsPerKey = await Promise.all(
        apiKeys.map(key => paginate(key, ENDPOINTS.campaigns, {}))
    );

    let processedCampaigns = [];
    campaignsPerKey.forEach((campaignList, keyIndex) => {
        if (!campaignList) return;
        campaignList.forEach(c => {
            const accountId = c.linkedInAccountId ?? c.accountId ?? (c.campaignAccountIds && c.campaignAccountIds.length > 0 ? c.campaignAccountIds[0] : null);
            const account = accountsMap.get(accountId);
            const accountName = account ? `${account.firstName} ${account.lastName}` : "(No account name)";
            
            if (!account && accountId) {
                console.warn(`Could not find an account for campaign "${c.name}" (Searched for Account ID: ${accountId})`);
            }
            
            processedCampaigns.push({
                id: c.id,
                name: c.name,
                status: c.status,
                progressStats: c.progressStats || {},
                totalLeads: c.progressStats?.totalUsers || 0,
                linkedInAccountId: accountId,
                accountName: accountName,
                sourceKeyIdx: keyIndex,
                numContacted: 0,
                numReplies: 0,
                numUnread: 0,
                replyRate: "0%",
            });
        });
    });

    allCampaigns = [...new Map(processedCampaigns.map(item => [item.id, item])).values()];

    if (!allCampaigns.length) {
        setStatus("No campaigns found for the provided API key(s).", false);
        return;
    }

    setStatus("Fetching conversations and replies…", true);
    const promises = allCampaigns.map(c => () => fetchConversationStats(c));
    await runPromisesInPool(promises, 5);

    renderAll();
    setStatus("Done!", false);
  } catch (e) {
    console.error(e);
    setStatus(e.message || "An unexpected error occurred.", false, true);
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
      const currentStatus = qs("#status-message").textContent;
      setStatus(`API rate limit hit. Retrying... (${currentStatus})`, true);
      await new Promise((r) => setTimeout(r, delay));
      return apiPost(apiKey, endpoint, body, retries - 1, delay * 2);
    }

    if (!res.ok) {
        const errData = await res.text().catch(() => `HTTP error! status: ${res.status}`);
        throw new Error(`API request to ${endpoint} failed for key ...${apiKey.slice(-4)}: ${errData}`);
    }
    
    const responseText = await res.text();
    return responseText ? JSON.parse(responseText) : { items: [], totalCount: 0 };

  } catch (e) {
    throw e;
  }
}

async function paginate(apiKey, endpoint, body) {
  let offset = 0;
  const out = [];
  
  while(true) {
    const resp = await apiPost(apiKey, endpoint, { ...body, limit: PAGE_LIMIT, offset });
    const items = resp.items || [];
    if (items.length === 0) {
        break;
    }
    out.push(...items);
    offset += items.length;
  }

  return out;
}

// ---------- Application Logic -----------------------------------------------
async function fetchAllAccounts(keys) {
    const allResults = await Promise.all(
        keys.map(key => paginate(key, ENDPOINTS.accounts, {}))
    );
    const combined = allResults.flat();
    return [...new Map(combined.map(item => [item.id, item])).values()];
}

async function fetchConversationStats(c) {
  if (c.sourceKeyIdx === -1 || c.sourceKeyIdx === undefined) {
      console.warn(`Could not find source API key for campaign: ${c.name}`);
      return;
  }
  const apiKey = apiKeys[c.sourceKeyIdx];
  const filters = {
    campaignIds: [c.id],
    linkedInAccountIds: c.linkedInAccountId ? [c.linkedInAccountId] : []
  };

  const convos = await paginate(apiKey, ENDPOINTS.conversations, { filters });
  
  c.numContacted = convos.length;
  c.numReplies = convos.filter(cv => cv.messages && cv.messages.some(m => m.sender === 'CORRESPONDENT')).length;
  c.numUnread = convos.filter(cv => !cv.read).length;
  c.replyRate = c.numContacted > 0 ? `${((c.numReplies / c.numContacted) * 100).toFixed(1)}%` : "0%";
}


// ---------- UI -------------------------------------------------------------
function setStatus(msg, loading, error = false) {
  qs("#status-message").textContent = msg;
  qs("#loader").classList.toggle("hidden", !loading);
  qs("#status-message").classList.remove("text-red-600", "text-green-600");
  if (error) {
    qs("#status-message").classList.add("text-red-600");
  } else if (!loading && msg === 'Done!') {
    qs("#status-message").classList.add("text-green-600");
  }
}

function resetUI() {
  allCampaigns = [];
  allAccounts = [];
  qs("#results-section").classList.add("hidden");
  qs("#summary-grid").innerHTML = "";
  qs("#campaigns-table tbody").innerHTML = "";
  if (chartInstance) chartInstance.destroy();
}

function renderAll() {
  qs("#results-section").classList.remove("hidden");
  populateFilters();
  refreshTable();
}

function updateCampaignFilter() {
    const accId = qs("#filter-account").value;
    const campSel = qs("#filter-campaign");

    const relevantCampaigns = accId === 'all'
        ? allCampaigns
        : allCampaigns.filter(c => String(c.linkedInAccountId) === accId);
    
    campSel.innerHTML = '<option value="all">All Campaigns</option>' +
      relevantCampaigns
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(c => `<option value="${c.id}">${c.name}</option>`).join("");
}

function populateFilters() {
    const accSel = qs("#filter-account");
    const campSel = qs("#filter-campaign");

    // Populate Account Filter
    accSel.innerHTML = '<option value="all">All Accounts</option>' +
      allAccounts
        .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`))
        .map(acc => `<option value="${acc.id}">${acc.firstName} ${acc.lastName}</option>`).join("");
    
    accSel.disabled = false;
    accSel.addEventListener("change", () => {
        updateCampaignFilter();
        refreshTable();
    });

    // Initial population of campaign filter, then set up its listener
    updateCampaignFilter();
    campSel.disabled = false;
    campSel.addEventListener("change", refreshTable);

    // Populate Status Filters
    const statusWrapper = qs("#status-filters .space-y-2");
    statusWrapper.innerHTML = "";
    [...new Set(allCampaigns.map(c => c.status))].sort().forEach(st => {
        const id = `chk-status-${st}`;
        const color = STATUS_COLORS[st] || STATUS_COLORS.default;
        statusWrapper.insertAdjacentHTML("beforeend", `
            <label class="flex items-center space-x-2 cursor-pointer">
                <input type="checkbox" id="${id}" data-val="${st}" checked class="accent-primary h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary">
                <span class="w-3 h-3 rounded-full" style="background-color: ${color};"></span>
                <span>${st}</span>
            </label>`);
        qs(`#${id}`).addEventListener("change", refreshTable);
    });
}

function applyFiltersSort(list) {
  const accId = qs("#filter-account").value;
  const campId = qs("#filter-campaign").value;
  const allowedStatuses = qsa("#status-filters input:checked").map(c => c.dataset.val);
  
  let arr = [...list];
  
  if (accId !== "all") {
    arr = arr.filter(c => String(c.linkedInAccountId) === accId);
  }
  if (campId !== "all") {
    arr = arr.filter(c => String(c.id) === campId);
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

function drawSummaryView() {
    const grid = qs("#summary-grid");
    grid.innerHTML = "";
    
    const filteredCampaigns = applyFiltersSort(allCampaigns);
    const campaignId = qs("#filter-campaign").value;
    const summaryTitle = campaignId !== 'all' 
        ? `Summary for "${filteredCampaigns.length > 0 ? filteredCampaigns[0].name : ''}"`
        : `Summary for ${filteredCampaigns.length} Campaigns`;

    const totalContacted = filteredCampaigns.reduce((s, c) => s + (c.numContacted || 0), 0);
    const totalReplies = filteredCampaigns.reduce((s, c) => s + (c.numReplies || 0), 0);
    const totalUnread = filteredCampaigns.reduce((s, c) => s + (c.numUnread || 0), 0);
    const overallReplyRate = totalContacted > 0 ? `${((totalReplies / totalContacted) * 100).toFixed(1)}%` : "0.0%";

    const progressSummary = { totalUsers: 0, totalUsersInProgress: 0, totalUsersPending: 0, totalUsersFinished: 0, totalUsersFailed: 0, totalUsersExcluded: 0 };
    filteredCampaigns.forEach(c => {
        if (c.progressStats) {
            Object.keys(progressSummary).forEach(key => progressSummary[key] += c.progressStats[key] || 0);
        }
    });

    const reportItemHeaderStyle = "text-sm text-text-muted dark:text-text-muted mb-1 uppercase";
    const reportItemValueStyle = "text-3xl font-bold text-base-text dark:text-base-text";

    const summaryHtml = `
        <h2 class="text-2xl font-bold mb-4 col-span-1 sm:col-span-2 lg:col-span-3">${summaryTitle}</h2>
        
        <div class="bg-surface dark:bg-surface p-6 rounded-xl shadow-subtle border border-border dark:border-border col-span-1 sm:col-span-2 lg:col-span-3">
            <h3 class="text-xl font-semibold mb-4 text-base-text dark:text-base-text">Conversation Statistics</h3>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-5 text-center">
                <div><p class="${reportItemHeaderStyle}">Started</p><p class="${reportItemValueStyle}">${totalContacted}</p></div>
                <div><p class="${reportItemHeaderStyle}">Replied</p><p class="${reportItemValueStyle}">${totalReplies}</p></div>
                <div><p class="${reportItemHeaderStyle}">Unread</p><p class="${reportItemValueStyle}">${totalUnread}</p></div>
                <div><p class="${reportItemHeaderStyle}">Reply Rate</p><p class="${reportItemValueStyle}">${overallReplyRate}</p></div>
            </div>
        </div>

        <div class="bg-surface dark:bg-surface p-6 rounded-xl shadow-subtle border border-border dark:border-border col-span-1 sm:col-span-2 lg:col-span-3">
            <h3 class="text-xl font-semibold mb-4 text-base-text dark:text-base-text">Overall Campaign Progress</h3>
            <div class="grid grid-cols-2 md:grid-cols-3 gap-5 text-center">
                <div><p class="${reportItemHeaderStyle}">Total Leads</p><p class="${reportItemValueStyle}">${progressSummary.totalUsers}</p></div>
                <div><p class="${reportItemHeaderStyle}">In Progress</p><p class="${reportItemValueStyle}">${progressSummary.totalUsersInProgress}</p></div>
                <div><p class="${reportItemHeaderStyle}">Pending</p><p class="${reportItemValueStyle}">${progressSummary.totalUsersPending}</p></div>
                <div><p class="${reportItemHeaderStyle}">Finished</p><p class="${reportItemValueStyle}">${progressSummary.totalUsersFinished}</p></div>
                <div><p class="${reportItemHeaderStyle}">Failed</p><p class="${reportItemValueStyle}">${progressSummary.totalUsersFailed}</p></div>
                <div><p class="${reportItemHeaderStyle}">Excluded</p><p class="${reportItemValueStyle}">${progressSummary.totalUsersExcluded}</p></div>
            </div>
        </div>
    `;
    grid.innerHTML = summaryHtml;
}


function drawStatusChart() {
  const ctx = qs("#status-chart").getContext("2d");
  const filteredCampaigns = applyFiltersSort(allCampaigns);
  
  const tally = {};
  filteredCampaigns.forEach((c) => tally[c.status] = (tally[c.status] || 0) + 1);
  
  const labels = Object.keys(tally);
  const dataValues = Object.values(tally);
  const backgroundColors = labels.map(label => STATUS_COLORS[label] || STATUS_COLORS.default);
  const isDark = document.documentElement.classList.contains('dark');

  const data = { 
      labels: labels, 
      datasets: [{ 
          data: dataValues,
          backgroundColor: backgroundColors,
          borderColor: isDark ? 'hsl(222, 24%, 15%)' : '#ffffff',
          borderWidth: 2
      }] 
  };
  
  if (chartInstance) chartInstance.destroy();
  
  chartInstance = new Chart(ctx, { 
      type: "doughnut", 
      data, 
      options: { 
          responsive: true, 
          plugins: { 
              legend: { 
                  position: "bottom",
                  labels: {
                      usePointStyle: true,
                      pointStyle: 'rectRounded',
                      color: isDark ? 'hsl(210, 30%, 96%)' : 'hsl(220, 18%, 22%)'
                  }
              } 
          } 
      } 
  });
}

function refreshTable() {
  const tbody = qs("#campaigns-table tbody");
  tbody.innerHTML = "";
  const filteredData = applyFiltersSort(allCampaigns);

  filteredData.forEach((c) => {
    const tr = document.createElement("tr");
    const color = STATUS_COLORS[c.status] || STATUS_COLORS.default;
    tr.className = "hover:bg-gray-50 dark:hover:bg-surface/50 cursor-pointer transition-colors duration-150";
    tr.innerHTML = `
        <td class="p-4 font-medium">${escapeHTML(c.name)}</td>
        <td class="p-4">${escapeHTML(c.accountName)}</td>
        <td class="p-4">
            <div class="flex items-center">
                <span class="w-3 h-3 rounded-full mr-2" style="background-color: ${color};"></span>
                <span>${escapeHTML(c.status)}</span>
            </div>
        </td>
        <td class="p-4 text-center">${c.totalLeads}</td>
        <td class="p-4 text-center">${c.numContacted}</td>
        <td class="p-4 text-center">${c.numReplies}</td>
        <td class="p-4 text-center font-semibold">${c.replyRate}</td>`;
    tr.addEventListener("click", () => openModal(c));
    tbody.appendChild(tr);
  });
  
  drawSummaryView();
  drawStatusChart();
}

async function openModal(campaign) {
  const dlg = qs("#leads-modal");
  dlg.showModal();
  qs("#modal-title").textContent = `Conversations: ${campaign.name} (${campaign.accountName})`;
  qs("#modal-loader").classList.remove("hidden");
  qs("#modal-content-container").classList.add('hidden');
  qs("#conversations-list").innerHTML = "";
  qs("#messages-thread").innerHTML = "";

  try {
    const apiKey = apiKeys[campaign.sourceKeyIdx];
    const convos = await paginate(apiKey, ENDPOINTS.conversations, {
      filters: {
        campaignIds: [campaign.id],
        linkedInAccountIds: campaign.linkedInAccountId ? [campaign.linkedInAccountId] : [],
      },
    });
    
    qs("#modal-content-container").classList.remove('hidden');
    
    // REVERTED: Filter for conversations that have a reply from the correspondent
    activeModalConversations = convos.filter(c => c.messages && c.messages.some(m => m.sender === 'CORRESPONDENT'));

    if (!activeModalConversations.length) {
      qs("#conversations-list").innerHTML = '<p class="p-4 text-sm text-text-muted dark:text-text-muted">No conversations with replies in this campaign.</p>';
      qs("#messages-thread").innerHTML = '';
      return;
    }
    
    qs("#conversations-list").innerHTML = '';
    activeModalConversations.forEach((convo) => {
      const div = document.createElement("div");
      div.className = "p-4 border-b border-border dark:border-border hover:bg-gray-100 dark:hover:bg-surface/50 cursor-pointer transition-colors duration-150";
      div.dataset.convoId = convo.id;
      div.innerHTML = `
        <p class="font-medium truncate">${escapeHTML(convo.correspondentProfile.firstName)} ${escapeHTML(convo.correspondentProfile.lastName)}</p>
        <p class="text-xs text-text-muted dark:text-text-muted truncate">${escapeHTML(convo.lastMessageText) ?? 'No messages yet'}</p>`;
      div.addEventListener("click", (e) => {
          qsa('#conversations-list > div').forEach(el => el.classList.remove('bg-gray-100', 'dark:bg-surface/50'));
          e.currentTarget.classList.add('bg-gray-100', 'dark:bg-surface/50');
          displayMessages(convo.id);
      });
      qs("#conversations-list").appendChild(div);
    });
    
    if (activeModalConversations.length > 0) {
        const firstConvo = activeModalConversations[0];
        qs('#conversations-list > div:first-child').classList.add('bg-gray-100', 'dark:bg-surface/50');
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
    thread.innerHTML = `<p class="p-4 text-text-muted dark:text-text-muted">No messages found for this conversation.</p>`;
    return;
  }

  (convo.messages || []).forEach((m) => {
    const incoming = m.sender === "CORRESPONDENT";
    const div = document.createElement("div");
    div.className = `flex flex-col ${incoming ? 'items-start' : 'items-end'}`;
    div.innerHTML = `<div class="message-bubble ${incoming ? "message-received" : "message-sent"}">
      <p class="whitespace-pre-wrap">${escapeHTML(m.body || "(no content)")}</p>
      <span class="block mt-1 text-xs opacity-70 text-right">${new Date(m.createdAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}</span>
    </div>`;
    thread.appendChild(div);
  });
  thread.scrollTop = thread.scrollHeight;
}


function escapeHTML(str) {
  if (typeof str !== 'string' || !str) return '';
  return str.replace(/[&<>"']/g, (c) => ({ 
      "&": "&amp;", 
      "<": "&lt;", 
      ">": "&gt;", 
      '"': "&quot;",
      "'": "&#39;"
  }[c]));
}

async function runPromisesInPool(promiseFns, poolLimit) {
    const results = [];
    const executing = [];
    for (const promiseFn of promiseFns) {
        const p = Promise.resolve().then(() => promiseFn());
        results.push(p);
        if (poolLimit <= promiseFns.length) {
            const e = p.then(() => executing.splice(executing.indexOf(e), 1));
            executing.push(e);
            if (executing.length >= poolLimit) {
                await Promise.race(executing);
            }
        }
    }
    return Promise.all(results);
}


// ---------- Initialization --------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  if (qs("#theme-toggle")) themeInit();
  if (qs("#fetch-data-btn")) qs("#fetch-data-btn").addEventListener("click", onFetchData);
  if (qs("#sort-by")) qs("#sort-by").addEventListener("change", refreshTable);
  if (qs("#sort-dir-btn")) qs("#sort-dir-btn").addEventListener("click", () => {
    sortAsc = !sortAsc;
    qs("#sort-dir-btn svg").classList.toggle("rotate-180", !sortAsc);
    refreshTable();
  });
  if (qs("#modal-close-btn")) qs("#modal-close-btn").addEventListener("click", () => qs("#leads-modal").close());
  
  const savedKey = localStorage.getItem('heyreach_api_key');
  if (savedKey) {
      qs('#api-key-1').value = savedKey;
  }
});
