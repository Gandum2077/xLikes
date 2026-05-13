(function () {
  "use strict";

  var appEl = document.getElementById("app");
  var tabbarEl = document.getElementById("tabbar");
  var navLeftEl = document.getElementById("navLeft");
  var navTitleEl = document.getElementById("navTitle");
  var navRightEl = document.getElementById("navRight");
  var modalRootEl = document.getElementById("modalRoot");
  var toastEl = document.getElementById("toast");
  var mediaObserver = null;
  var toastTimer = null;
  var progressTimers = {};
  var mediaRenderFlushTimer = null;
  var SCROLL_RENDER_DEFER_MS = 900;

  var state = {
    activeTab: "status",
    status: null,
    browseItems: [],
    browseOffset: 0,
    browseTotal: 0,
    browseHasMore: false,
    browseLoading: false,
    browseQuery: "",
    browseTitle: "",
    browseMode: "list",
    tags: [],
    tagSort: "count",
    syncing: false,
    autoSyncTried: false,
    downloading: {},
    downloadProgress: {},
    pendingMediaRenders: {},
    scrollQuietUntil: 0,
    searchOpen: false,
    search: {
      q: "",
      includeArchived: false,
      minRating: 0,
      mediaDownloaded: "",
      sort: "normal",
      startDate: "",
      endDate: "",
      randomSeed: "",
      items: [],
      offset: 0,
      total: 0,
      hasMore: false,
      loading: false,
      history: [],
      controlsVisible: false
    }
  };

  function apiGet(path, params) {
    return axios.get(path, { params: params || {} }).then(readApiResponse);
  }

  function apiPost(path, data) {
    return axios.post(path, data || {}).then(readApiResponse);
  }

  function readApiResponse(response) {
    if (response.data && response.data.ok) {
      return response.data.data;
    }
    throw new Error(response.data && response.data.error ? response.data.error : "请求失败");
  }

  function handleError(err) {
    var message = err && err.response && err.response.data && err.response.data.error ? err.response.data.error : err.message;
    showToast(message || "操作失败");
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.classList.remove("hidden");
    toastTimer = setTimeout(function () {
      toastEl.classList.add("hidden");
    }, 3200);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function linkifyText(value) {
    var escaped = escapeHtml(value);
    return escaped.replace(/(https?:\/\/[^\s<]+)/g, function (match) {
      return '<a href="' + match + '" target="_blank" rel="noreferrer">' + match + "</a>";
    });
  }

  function formatNumber(value) {
    var num = Number(value || 0);
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    }
    if (num >= 10000) {
      return (num / 10000).toFixed(1).replace(/\.0$/, "") + "万";
    }
    return String(num);
  }

  function formatBytes(value) {
    var bytes = Number(value || 0);
    if (bytes >= 1024 * 1024 * 1024) {
      return (bytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "") + "GB";
    }
    if (bytes >= 1024 * 1024) {
      return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "") + "MB";
    }
    if (bytes >= 1024) {
      return (bytes / 1024).toFixed(1).replace(/\.0$/, "") + "KB";
    }
    return bytes + "B";
  }

  function formatDate(value) {
    if (!value) {
      return "";
    }
    var date = new Date(value);
    if (isNaN(date.getTime())) {
      return value;
    }
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function formatDateTime(value) {
    if (!value) {
      return "";
    }
    var date = new Date(value);
    if (isNaN(date.getTime())) {
      return value;
    }
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function closestAction(target) {
    while (target && target !== document.body) {
      if (target.getAttribute && target.getAttribute("data-action")) {
        return target;
      }
      target = target.parentNode;
    }
    return null;
  }

  function setNav(options) {
    navLeftEl.classList.toggle("hidden", !options.leftText);
    navLeftEl.textContent = options.leftText || "";
    navLeftEl.onclick = options.leftClick || null;

    navRightEl.classList.toggle("hidden", !options.rightText);
    navRightEl.textContent = options.rightText || "";
    navRightEl.onclick = options.rightClick || null;

    if (options.titleHtml) {
      navTitleEl.innerHTML = options.titleHtml;
    } else {
      navTitleEl.textContent = options.title || "";
    }
  }

  function setActiveTab(tab) {
    var buttons = tabbarEl.querySelectorAll(".tab");
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].classList.toggle("active", buttons[i].getAttribute("data-tab") === tab);
    }
  }

  function navigate(tab) {
    state.searchOpen = false;
    tabbarEl.classList.remove("hidden");
    state.activeTab = tab;
    setActiveTab(tab);
    if (tab === "status") {
      loadStatusPage();
    } else if (tab === "browse") {
      openBrowse("", "");
    } else if (tab === "tags") {
      loadTagsPage();
    }
  }

  function scrollToTop() {
    try {
      window.scrollTo({
        top: 0,
        behavior: "smooth"
      });
    } catch (err) {
      window.scrollTo(0, 0);
    }
  }

  function loadStatusPage() {
    setNav({
      title: "状态",
      rightText: "",
      leftText: ""
    });
    appEl.innerHTML = '<div class="loading">正在读取本地状态...</div>';
    apiGet("/api/status").then(function (data) {
      state.status = data;
      if (data.settings) {
        state.tagSort = data.settings.tagSort || "count";
      }
      renderStatus();
      if (data.settings && data.settings.hasAccessToken) {
        if (data.settings.userId) {
          maybeAutoSync(data.settings);
        }
      }
    }).catch(handleError);
  }

  function renderStatus() {
    var data = state.status;
    if (!data) {
      return;
    }
    var settings = data.settings || {};
    if (!settings.hasAccessToken || !settings.userId) {
      renderSetup(settings);
      return;
    }
    var sync = data.sync || {};
    appEl.innerHTML = [
      '<section class="panel">',
      '<div class="row between">',
      '<div>',
      '<h2>' + escapeHtml(settings.name || "已连接 X API") + "</h2>",
      '<div class="inline-muted">@' + escapeHtml(settings.username || "unknown") + " · User ID " + escapeHtml(settings.userId) + "</div>",
      "</div>",
      settings.profileImageUrl ? '<img class="avatar" src="' + escapeHtml(settings.profileImageUrl) + '" alt="" loading="lazy" decoding="async">' : '<div class="avatar fallback">X</div>',
      "</div>",
      '<div class="stats-grid" style="margin-top:14px">',
      statHtml(formatNumber(data.stats.totalTweets), "本地推文"),
      statHtml(formatNumber(data.stats.archivedTweets), "已归档"),
      statHtml(formatNumber(data.stats.taggedTweets), "有标签"),
      "</div>",
      "</section>",
      '<section class="panel">',
      '<h3>同步</h3>',
      '<label class="switch-row"><span>启动时自动增量同步</span><input id="autoSyncToggle" type="checkbox" ' + (settings.autoSyncOnStart ? "checked" : "") + "></label>",
      '<div class="row">',
      '<button class="button" type="button" data-action="sync-incremental" ' + (state.syncing ? "disabled" : "") + ">增量同步</button>",
      '<button class="button secondary" type="button" data-action="sync-full" ' + (state.syncing ? "disabled" : "") + ">完全同步</button>",
      "</div>",
      syncHtml(sync),
      "</section>",
      '<section class="panel">',
      '<h3>OAuth 2.0 Keys</h3>',
      '<p class="inline-muted">Client ID：' + escapeHtml(settings.clientId || "未填写") + "</p>",
      '<p class="inline-muted">Client Secret：' + (settings.hasClientSecret ? "已保存" : "未保存") + "</p>",
      '<p class="inline-muted">Access Token：' + (settings.hasAccessToken ? escapeHtml(settings.tokenPreview || "已保存") : "未保存") + "</p>",
      '<p class="inline-muted">Refresh Token：' + (settings.hasRefreshToken ? escapeHtml(settings.refreshTokenPreview || "已保存") : "未保存") + "</p>",
      settings.tokenExpiresAt ? '<p class="inline-muted">Token 预计过期：' + escapeHtml(formatDateTime(settings.tokenExpiresAt)) + "</p>" : "",
      settings.lastTokenRefreshAt ? '<p class="inline-muted">上次刷新：' + escapeHtml(formatDateTime(settings.lastTokenRefreshAt)) + "</p>" : "",
      settings.lastTokenRefreshError ? '<p class="inline-muted">上次刷新失败：' + escapeHtml(settings.lastTokenRefreshError) + "</p>" : "",
      '<div class="row"><button class="button ghost" type="button" data-action="edit-credentials">更新凭据</button><button class="button secondary" type="button" data-action="refresh-token" ' + (!(settings.hasRefreshToken && settings.clientId) ? "disabled" : "") + '>刷新 Token</button></div>',
      "</section>"
    ].join("");

    var toggle = document.getElementById("autoSyncToggle");
    if (toggle) {
      toggle.onchange = function () {
        apiPost("/api/settings", { autoSyncOnStart: toggle.checked }).then(function (updated) {
          state.status.settings = updated;
          showToast("设置已保存");
        }).catch(handleError);
      };
    }
  }

  function statHtml(value, label) {
    return '<div class="stat"><strong>' + escapeHtml(value) + "</strong><span>" + escapeHtml(label) + "</span></div>";
  }

  function syncHtml(sync) {
    if (state.syncing) {
      return '<div class="loading">同步进行中，请保持页面打开...</div>';
    }
    if (sync && sync.lastError) {
      return '<p class="inline-muted">上次同步失败：' + escapeHtml(sync.lastError) + "</p>";
    }
    if (!sync || !sync.lastSummary) {
      return '<p class="inline-muted">尚未同步。增量同步每次只读取 5 条，遇到本地重复推文后停止；完全同步会批量遍历全部可访问点赞。</p>';
    }
    var s = sync.lastSummary;
    return '<p class="inline-muted">上次' + (s.mode === "full" ? "完全" : "增量") + "同步：新增 " + s.added + "，更新 " + s.updated + "，页数 " + s.pages + (s.maxResults ? "，每次读取 " + s.maxResults + " 条" : "") + "。</p>";
  }

  function renderSetup(settings) {
    appEl.innerHTML = [
      '<section class="panel">',
      "<h2>连接 X API</h2>",
      '<p>这个应用只在本地运行。请按 X Developer Console 的 OAuth 2.0 Keys 填写凭据；应用会通过 OAuth 2.0 用户 Token 自动识别当前授权用户。</p>',
      '<ol class="guide-list">',
      '<li>打开 <a href="https://console.x.com/" target="_blank" rel="noreferrer">console.x.com</a>，使用你的 X 账号登录并接受开发者协议。</li>',
      "<li>创建 Project 和 App，进入 User authentication settings，启用 OAuth 2.0 Authorization Code with PKCE。</li>",
      "<li>在 App 权限里选择读取权限，并在 scope 中至少包含 tweet.read、users.read、like.read；需要长期使用时再包含 offline.access。</li>",
      "<li>完成 OAuth 2.0 用户授权流程，复制 Client ID、Client Secret、Access Token 和 Refresh Token。应用会写入本地 .env，并在 Access Token 过期时自动刷新。</li>",
      "<li>点击保存并测试后，应用会调用 /2/users/me 自动获取当前授权账号的 User ID、用户名和头像。</li>",
      "</ol>",
      "</section>",
      '<section class="panel">',
      "<h3>OAuth 2.0 Keys</h3>",
      '<div class="field"><label for="clientIdInput">Client ID</label><input id="clientIdInput" spellcheck="false" value="' + escapeHtml(settings.clientId || "") + '" placeholder="OAuth 2.0 Client ID"></div>',
      '<div class="field"><label for="clientSecretInput">Client Secret</label><input id="clientSecretInput" spellcheck="false" type="password" placeholder="可选；public client 可留空，留空则保留当前值"></div>',
      '<div class="field"><label for="accessTokenInput">Access Token</label><textarea id="accessTokenInput" spellcheck="false" placeholder="粘贴 OAuth 2.0 用户上下文 access_token，可带或不带 Bearer 前缀"></textarea></div>',
      '<p class="inline-muted">' + (settings.hasAccessToken ? "已保存：" + escapeHtml(settings.tokenPreview || "Access Token") + "。留空则保留当前值。" : "必须使用 OAuth 2.0 User Context Access Token。") + "</p>",
      '<div class="field"><label for="refreshTokenInput">Refresh Token</label><textarea id="refreshTokenInput" spellcheck="false" placeholder="请求 offline.access 后返回的 refresh_token；留空则保留当前值"></textarea></div>',
      '<p class="inline-muted">' + (settings.hasRefreshToken ? "已保存：" + escapeHtml(settings.refreshTokenPreview || "Refresh Token") + "。留空则保留当前值。" : "可选。配置后可以在 Access Token 过期时自动刷新。") + "</p>",
      '<label class="switch-row"><span>启动时自动增量同步</span><input id="setupAutoSync" type="checkbox" ' + (settings.autoSyncOnStart ? "checked" : "") + "></label>",
      '<div class="row"><button class="button" type="button" data-action="save-credentials">保存并测试</button></div>',
      "</section>"
    ].join("");
  }

  function saveCredentials() {
    var tokenEl = document.getElementById("accessTokenInput");
    var refreshTokenEl = document.getElementById("refreshTokenInput");
    var clientIdEl = document.getElementById("clientIdInput");
    var clientSecretEl = document.getElementById("clientSecretInput");
    var autoEl = document.getElementById("setupAutoSync");
    var payload = {
      accessToken: tokenEl ? tokenEl.value : "",
      refreshToken: refreshTokenEl ? refreshTokenEl.value : "",
      clientId: clientIdEl ? clientIdEl.value : "",
      clientSecret: clientSecretEl ? clientSecretEl.value : "",
      autoSyncOnStart: autoEl ? autoEl.checked : false
    };
    apiPost("/api/settings", payload).then(function () {
      return apiPost("/api/auth/test", {});
    }).then(function () {
      showToast("连接成功");
      loadStatusPage();
    }).catch(handleError);
  }

  function showCredentialEditor() {
    var settings = state.status && state.status.settings ? state.status.settings : {};
    showModal([
      "<h3>更新凭据</h3>",
      '<div class="credential-block">',
      "<h4>OAuth 2.0 Keys</h4>",
      '<div class="field"><label>Client ID</label><input id="modalClientId" spellcheck="false" value="' + escapeHtml(settings.clientId || "") + '" placeholder="OAuth 2.0 Client ID"></div>',
      '<div class="field"><label>Client Secret</label><input id="modalClientSecret" type="password" spellcheck="false" placeholder="留空则保留当前 Client Secret"></div>',
      '<div class="field"><label>Access Token</label><textarea id="modalToken" spellcheck="false" placeholder="留空则保留当前 Access Token"></textarea></div>',
      '<p class="inline-muted">' + (settings.hasAccessToken ? "已保存：" + escapeHtml(settings.tokenPreview || "Access Token") : "未保存") + "</p>",
      '<div class="field"><label>Refresh Token</label><textarea id="modalRefreshToken" spellcheck="false" placeholder="留空则保留当前 Refresh Token"></textarea></div>',
      '<p class="inline-muted">' + (settings.hasRefreshToken ? "已保存：" + escapeHtml(settings.refreshTokenPreview || "Refresh Token") : "未保存") + "</p>",
      "</div>",
      '<div class="modal-actions">',
      '<button class="button ghost" type="button" data-modal-close>取消</button>',
      '<button class="button" type="button" id="saveCredentialModal">保存并测试</button>',
      "</div>"
    ].join(""), function () {
      document.getElementById("saveCredentialModal").onclick = function () {
        apiPost("/api/settings", {
          accessToken: document.getElementById("modalToken").value,
          refreshToken: document.getElementById("modalRefreshToken").value,
          clientId: document.getElementById("modalClientId").value,
          clientSecret: document.getElementById("modalClientSecret").value
        }).then(function () {
          return apiPost("/api/auth/test", {});
        }).then(function () {
          closeModal();
          showToast("凭据已更新");
          loadStatusPage();
        }).catch(handleError);
      };
    });
  }

  function manualRefreshToken() {
    apiPost("/api/auth/refresh", {}).then(function (settings) {
      if (state.status) {
        state.status.settings = settings;
      }
      showToast("Token 已刷新");
      if (state.activeTab === "status" && !state.searchOpen) {
        renderStatus();
      }
    }).catch(handleError);
  }

  function maybeAutoSync(settings) {
    if (state.autoSyncTried || !settings.autoSyncOnStart) {
      return;
    }
    state.autoSyncTried = true;
    runSync("incremental", true);
  }

  function runSync(mode, silent) {
    if (state.syncing) {
      return;
    }
    state.syncing = true;
    if (state.activeTab === "status" && !state.searchOpen) {
      renderStatus();
    }
    apiPost("/api/sync", { mode: mode }).then(function (summary) {
      state.syncing = false;
      if (!silent) {
        showToast("同步完成：新增 " + summary.added + "，更新 " + summary.updated);
      }
      return apiGet("/api/status");
    }).then(function (data) {
      state.status = data;
      if (state.activeTab === "status" && !state.searchOpen) {
        renderStatus();
      }
    }).catch(function (err) {
      state.syncing = false;
      renderStatus();
      handleError(err);
    });
  }

  function confirmFullSync() {
    if (state.syncing) {
      return;
    }
    showModal([
      "<h3>确认完全同步</h3>",
      '<p class="inline-muted">完全同步会从 X API 批量读取全部可访问点赞列表，可能消耗较多接口额度。确认继续吗？</p>',
      '<div class="modal-actions">',
      '<button class="button ghost" type="button" data-modal-close>取消</button>',
      '<button class="button danger" type="button" id="confirmFullSync">开始完全同步</button>',
      "</div>"
    ].join(""), function () {
      document.getElementById("confirmFullSync").onclick = function () {
        closeModal();
        runSync("full", false);
      };
    });
  }

  function openBrowse(query, title) {
    state.browseQuery = query || "";
    state.browseTitle = title || "";
    state.browseMode = "list";
    state.browseItems = [];
    state.browseOffset = 0;
    state.browseHasMore = false;
    setNav({
      title: state.browseTitle || "浏览",
      leftText: state.browseQuery ? "全部" : "",
      leftClick: function () {
        openBrowse("", "");
      },
      rightText: "搜索",
      rightClick: openSearchPage
    });
    renderBrowse();
    loadBrowse(true);
  }

  function renderBrowse() {
    var toolbar = [
      '<div class="toolbar browse-toolbar">',
      '<button class="button secondary" type="button" data-action="random-tweet">随机 10 条</button>',
      "</div>"
    ].join("");
    var body = "";
    if (state.browseItems.length) {
      body = renderTweetList(state.browseItems);
    } else if (state.browseLoading) {
      body = '<div class="loading">正在加载推文...</div>';
    } else {
      body = '<div class="empty">还没有本地推文。请先到状态页完成同步。</div>';
    }
    var more = state.browseLoading && state.browseItems.length ? '<div class="loading">继续加载...</div>' : "";
    appEl.innerHTML = toolbar + '<div id="tweetList">' + body + "</div>" + more;
    setupMediaObserver();
  }

  function loadBrowse(reset) {
    if (state.browseLoading) {
      return;
    }
    if (!reset && !state.browseHasMore) {
      return;
    }
    state.browseLoading = true;
    renderBrowse();
    apiGet("/api/tweets", {
      offset: reset ? 0 : state.browseOffset,
      limit: 50,
      q: state.browseQuery,
      includeArchived: false
    }).then(function (data) {
      state.browseLoading = false;
      state.browseTotal = data.total;
      state.browseHasMore = data.hasMore;
      state.browseOffset = data.offset + data.items.length;
      if (reset) {
        state.browseItems = data.items;
      } else {
        state.browseItems = state.browseItems.concat(data.items);
      }
      renderBrowse();
    }).catch(function (err) {
      state.browseLoading = false;
      renderBrowse();
      handleError(err);
    });
  }

  function loadRandomTweet() {
    apiGet("/api/tweets/random", { includeArchived: false, limit: 10 }).then(function (data) {
      var items = data && data.items ? data.items : [];
      if (!items.length) {
        showToast("还没有可随机查看的推文");
        return;
      }
      state.browseItems = items;
      state.browseOffset = items.length;
      state.browseHasMore = false;
      state.browseQuery = "";
      state.browseTitle = "";
      state.browseMode = "random";
      setNav({
        title: "随机 10 条",
        leftText: "全部",
        leftClick: function () {
          openBrowse("", "");
        },
        rightText: "搜索",
        rightClick: openSearchPage
      });
      renderBrowse();
    }).catch(handleError);
  }

  function renderTweetList(items) {
    var html = [];
    for (var i = 0; i < items.length; i += 1) {
      html.push(renderTweetCard(items[i]));
    }
    return html.join("");
  }

  function renderTweetCard(tweet) {
    var author = tweet.author || {};
    var metrics = tweet.publicMetrics || {};
    var archivedClass = tweet.archived ? " archived" : "";
    var avatar = author.profileImageUrl ? '<img class="avatar" src="' + escapeHtml(author.profileImageUrl) + '" alt="" loading="lazy" decoding="async">' : '<div class="avatar fallback">X</div>';
    var tags = renderLocalTags(tweet.tags || []);
    var note = tweet.note ? '<div class="note-box">' + escapeHtml(tweet.note) + "</div>" : "";
    var quote = renderReferenced(tweet.referencedTweets || []);
    return [
      '<article class="tweet-card' + archivedClass + '" data-tweet-id="' + escapeHtml(tweet.id) + '">',
      '<div class="tweet-head">',
      avatar,
      '<div><div class="tweet-name"><span>' + escapeHtml(author.name || "Unknown") + '</span></div>',
      '<div class="tweet-meta">@' + escapeHtml(author.username || "unknown") + " · " + escapeHtml(formatDate(tweet.createdAt)) + "</div></div>",
      '<button class="tweet-more" type="button" data-action="tweet-menu" data-id="' + escapeHtml(tweet.id) + '">•••</button>',
      "</div>",
      '<div class="tweet-text">' + linkifyText(tweet.text || "") + "</div>",
      quote,
      renderMedia(tweet),
      tags,
      note,
      '<div class="tweet-actions">',
      '<button class="action-button ' + (tweet.rating ? "active" : "") + '" type="button" data-action="rate" data-id="' + escapeHtml(tweet.id) + '">评分 ' + (tweet.rating || "-") + "</button>",
      '<button class="action-button" type="button" data-action="tag" data-id="' + escapeHtml(tweet.id) + '">标签</button>',
      '<button class="action-button" type="button" data-action="note" data-id="' + escapeHtml(tweet.id) + '">备注</button>',
      "</div>",
      '<span class="hidden" data-metrics="' + escapeHtml(JSON.stringify(metrics)) + '"></span>',
      "</article>"
    ].join("");
  }

  function renderReferenced(items) {
    if (!items.length) {
      return "";
    }
    var html = [];
    items.forEach(function (item) {
      if (!item.text) {
        return;
      }
      var author = item.author ? "@" + item.author.username + "：" : "";
      html.push('<div class="quoted">' + escapeHtml(item.type || "引用") + " · " + escapeHtml(author) + escapeHtml(item.text) + "</div>");
    });
    return html.join("");
  }

  function renderLocalTags(tags) {
    if (!tags || !tags.length) {
      return "";
    }
    return '<div class="tag-flow local-tags">' + tags.map(function (tag) {
      return '<span class="tag-chip">#' + escapeHtml(tag) + "</span>";
    }).join("") + "</div>";
  }

  function renderMedia(tweet) {
    var media = tweet.media || [];
    if (!media.length) {
      return "";
    }
    var html = ['<div class="media-grid count-' + Math.min(media.length, 4) + '">'];
    media.forEach(function (item) {
      var display = mediaDisplayInfo(item);
      var progress = mediaProgressForItem(tweet.id, item);
      html.push('<div class="media-item ' + display.className + '" style="' + display.style + '" data-media-status="' + escapeHtml(item.status || "") + '">');
      if (item.localPath) {
        if (item.type === "video" || item.type === "animated_gif") {
          var poster = item.previewImageUrl ? ' poster="' + escapeHtml(item.previewImageUrl) + '"' : "";
          html.push('<video src="' + escapeHtml(item.localPath) + '"' + poster + ' controls playsinline webkit-playsinline preload="none"></video>');
        } else {
          html.push('<img src="' + escapeHtml(item.localPath) + '" alt="' + escapeHtml(item.altText || "") + '" loading="lazy" decoding="async" data-action="image-viewer" data-src="' + escapeHtml(item.localPath) + '" data-alt="' + escapeHtml(item.altText || "") + '" data-ratio="' + escapeHtml(display.ratioText) + '">');
        }
      } else if (progress && (progress.status === "queued" || progress.status === "downloading")) {
        html.push(renderMediaProgress(tweet.id, progress));
      } else if (item.type === "video" && item.durationMs > 30000) {
        html.push('<div class="media-placeholder">视频约 ' + Math.round(item.durationMs / 1000) + ' 秒<br><button class="button secondary" type="button" data-action="download-long" data-id="' + escapeHtml(tweet.id) + '">下载视频</button></div>');
      } else if (item.status === "error") {
        html.push(renderMediaError(tweet.id, item));
      } else if (item.status === "downloading") {
        html.push('<div class="media-placeholder">正在下载媒体...</div>');
      } else {
        html.push('<div class="media-placeholder">媒体进入视口后自动下载</div>');
      }
      html.push("</div>");
    });
    html.push("</div>");
    return html.join("");
  }

  function renderMediaError(tweetId, item) {
    var needsRefresh = isNotFoundError(item.error || "");
    var hint = needsRefresh ? '<div class="media-retry-warning">远端媒体返回 404。点击重试会通过 X API 重新拉取该推文的媒体信息，可能产生费用。</div>' : "";
    return [
      '<div class="media-placeholder">',
      '<div>下载失败：' + escapeHtml(item.error || "") + "</div>",
      hint,
      '<button class="button secondary" type="button" data-action="retry-media" data-id="' + escapeHtml(tweetId) + '" data-refresh-remote="' + (needsRefresh ? "true" : "false") + '">重试</button>',
      "</div>"
    ].join("");
  }

  function isNotFoundError(message) {
    return String(message || "").indexOf("404") !== -1;
  }

  function mediaProgressForItem(tweetId, item) {
    var job = state.downloadProgress[tweetId];
    if (!job || !job.media) {
      return null;
    }
    for (var i = 0; i < job.media.length; i += 1) {
      if (String(job.media[i].mediaKey) === String(item.mediaKey || "")) {
        return job.media[i];
      }
    }
    return null;
  }

  function renderMediaProgress(tweetId, progress) {
    var percent = Number(progress.percent || 0);
    var bytesText = progress.totalBytes ? formatBytes(progress.downloadedBytes) + " / " + formatBytes(progress.totalBytes) : formatBytes(progress.downloadedBytes || 0);
    return [
      '<div class="media-placeholder media-progress">',
      '<div class="progress-title">正在下载' + (progress.type === "video" ? "视频" : "媒体") + "</div>",
      '<div class="progress-bar" aria-label="下载进度"><span style="width:' + Math.max(0, Math.min(100, percent)) + '%"></span></div>',
      '<div class="progress-meta">' + Math.round(percent) + "% · " + escapeHtml(bytesText) + "</div>",
      "</div>"
    ].join("");
  }

  function mediaDisplayInfo(item) {
    var width = Number(item.width || 0);
    var height = Number(item.height || 0);
    var ratio = width > 0 && height > 0 ? width / height : 1;
    var capped = Math.max(0.5, Math.min(2, ratio));
    var className = "media-fit-cover";
    if (item.type === "photo" && ratio >= 0.5 && ratio <= 2) {
      className = "media-fit-contain";
      capped = ratio;
    }
    if (item.type === "photo" && ratio < 0.5) {
      className += " media-tall";
    }
    if (item.type === "photo" && ratio > 2) {
      className += " media-wide";
    }
    return {
      className: className,
      style: "aspect-ratio:" + capped.toFixed(4) + "/1;",
      ratio: ratio,
      ratioText: String(ratio)
    };
  }

  function setupMediaObserver() {
    if (mediaObserver) {
      mediaObserver.disconnect();
    }
    var cards = appEl.querySelectorAll(".tweet-card");
    if (!("IntersectionObserver" in window)) {
      for (var i = 0; i < cards.length; i += 1) {
        autoDownloadForCard(cards[i]);
      }
      return;
    }
    mediaObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          autoDownloadForCard(entry.target);
          mediaObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: "240px 0px" });
    for (var j = 0; j < cards.length; j += 1) {
      mediaObserver.observe(cards[j]);
    }
  }

  function autoDownloadForCard(card) {
    var id = card.getAttribute("data-tweet-id");
    var tweet = findTweetInState(id);
    if (!tweet || !shouldAutoDownload(tweet)) {
      return;
    }
    downloadMedia(id, false);
  }

  function shouldAutoDownload(tweet) {
    var media = tweet.media || [];
    for (var i = 0; i < media.length; i += 1) {
      if (!media[i].localPath && media[i].status !== "deferred" && media[i].status !== "error" && !(media[i].type === "video" && media[i].durationMs > 30000)) {
        return true;
      }
    }
    return false;
  }

  function downloadMedia(id, forceLong, refreshRemote) {
    if (state.downloading[id]) {
      return;
    }
    state.downloading[id] = true;
    markMediaDownloading(id, forceLong);
    renderTweetWhenIdle(id);
    apiPost("/api/tweets/" + encodeURIComponent(id) + "/media/download", {
      forceLong: !!forceLong,
      refreshRemote: !!refreshRemote
    }).then(function (data) {
      var tweet = data && data.tweet ? data.tweet : data;
      var progress = data && data.progress ? data.progress : null;
      if (tweet) {
        updateTweetInState(tweet);
      }
      if (progress) {
        state.downloadProgress[id] = progress;
      }
      if (!progress || progress.status === "completed" || progress.status === "error") {
        finishProgressPolling(id, progress);
      } else {
        scheduleProgressPoll(id);
        renderTweetWhenIdle(id);
      }
    }).catch(function (err) {
      delete state.downloading[id];
      clearProgressTimer(id);
      renderTweetWhenIdle(id);
      handleError(err);
    });
  }

  function scheduleProgressPoll(id) {
    clearProgressTimer(id);
    progressTimers[id] = setTimeout(function () {
      apiGet("/api/tweets/" + encodeURIComponent(id) + "/media/progress").then(function (data) {
        var progress = data && data.progress ? data.progress : null;
        var tweet = data && data.tweet ? data.tweet : null;
        if (tweet) {
          updateTweetInState(tweet);
        }
        if (progress) {
          state.downloadProgress[id] = progress;
        }
        if (!progress || progress.status === "completed" || progress.status === "error") {
          finishProgressPolling(id, progress);
        } else {
          renderTweetWhenIdle(id);
          scheduleProgressPoll(id);
        }
      }).catch(function (err) {
        clearProgressTimer(id);
        delete state.downloading[id];
        renderTweetWhenIdle(id);
        handleError(err);
      });
    }, 500);
  }

  function finishProgressPolling(id, progress) {
    clearProgressTimer(id);
    delete state.downloading[id];
    if (progress) {
      state.downloadProgress[id] = progress;
      if (progress.status === "error" && progress.error) {
        showToast(progress.error);
      }
    }
    renderTweetWhenIdle(id);
  }

  function clearProgressTimer(id) {
    if (progressTimers[id]) {
      clearTimeout(progressTimers[id]);
      delete progressTimers[id];
    }
  }

  function markMediaDownloading(id, forceLong) {
    var tweet = findTweetInState(id);
    if (!tweet || !tweet.media) {
      return;
    }
    for (var i = 0; i < tweet.media.length; i += 1) {
      if (tweet.media[i].localPath) {
        continue;
      }
      if (tweet.media[i].type === "video" && tweet.media[i].durationMs > 30000 && !forceLong) {
        continue;
      }
      tweet.media[i].status = "downloading";
    }
  }

  function loadTagsPage() {
    setNav({
      title: "标签",
      leftText: "",
      rightText: ""
    });
    appEl.innerHTML = '<div class="loading">正在读取标签...</div>';
    loadTags(function () {
      renderTagsPage();
    });
  }

  function loadTags(done) {
    apiGet("/api/tags", { sort: state.tagSort || "count" }).then(function (data) {
      state.tags = data.tags || [];
      state.tagSort = data.sort || "count";
      if (done) {
        done();
      }
    }).catch(handleError);
  }

  function renderTagsPage() {
    var toolbar = [
      '<div class="toolbar tags-toolbar">',
      '<div></div>',
      '<div class="field tag-sort-field">',
      '<select id="tagSortSelect">',
      '<option value="name" ' + (state.tagSort === "name" ? "selected" : "") + ">按名称排序</option>",
      '<option value="count" ' + (state.tagSort === "count" ? "selected" : "") + ">按数量排序</option>",
      "</select>",
      "</div>",
      "</div>"
    ].join("");
    if (!state.tags.length) {
      appEl.innerHTML = toolbar + '<div class="empty">还没有标签。给推文添加标签后会显示在这里。</div>';
      bindTagSortSelect();
      return;
    }
    appEl.innerHTML = toolbar + '<div class="list">' + state.tags.map(function (item) {
      return '<button class="list-row" type="button" data-action="browse-tag" data-tag="' + escapeHtml(item.tag) + '"><span>#' + escapeHtml(item.tag) + '</span><span class="count-pill">' + item.count + "</span></button>";
    }).join("") + "</div>";
    bindTagSortSelect();
  }

  function bindTagSortSelect() {
    var select = document.getElementById("tagSortSelect");
    if (!select) {
      return;
    }
    select.onchange = function () {
      apiPost("/api/settings/tag-sort", { sort: select.value === "name" ? "name" : "count" }).then(function (settings) {
        state.tagSort = settings.tagSort;
        loadTagsPage();
      }).catch(handleError);
    };
  }

  function openSearchPage() {
    state.searchOpen = true;
    state.search.controlsVisible = true;
    tabbarEl.classList.add("hidden");
    renderSearchPage();
    loadTags(function () {
      renderSearchPage();
    });
  }

  function renderSearchPage() {
    setNav({
      leftText: "返回",
      leftClick: function () {
        state.searchOpen = false;
        tabbarEl.classList.remove("hidden");
        if (state.activeTab === "browse") {
          openBrowse(state.browseQuery, state.browseTitle);
        } else {
          navigate(state.activeTab);
        }
      },
      titleHtml: '<input id="searchInput" type="search" value="' + escapeHtml(state.search.q) + '" placeholder="搜索正文、作者、备注或 #标签">',
      rightText: "确认",
      rightClick: function () {
        performSearch(true);
      }
    });

    var topTags = state.tags.slice(0, 10).map(function (item) {
      return '<button class="tag-chip" type="button" data-action="search-add-tag" data-tag="' + escapeHtml(item.tag) + '">#' + escapeHtml(item.tag) + "</button>";
    }).join("");
    var history = (state.search.history.length ? state.search.history : (state.status && state.status.settings ? state.status.settings.searchHistory || [] : [])).map(function (item) {
      return '<button class="list-row" type="button" data-action="search-history" data-query="' + escapeHtml(item) + '"><span>' + escapeHtml(item) + "</span></button>";
    }).join("");
    var controls = "";
    var results = "";
    if (state.search.controlsVisible) {
      controls = [
        '<section class="panel">',
        '<h3>搜索参数</h3>',
        '<div class="search-options">',
        '<label class="switch-row"><span>包含已归档</span><input id="searchArchived" type="checkbox" ' + (state.search.includeArchived ? "checked" : "") + "></label>",
        '<div class="field" style="margin-top:0"><label>最低评分</label><select id="searchRating">',
        ratingOptions(state.search.minRating),
        "</select></div>",
        '<div class="field" style="margin-top:0"><label>是否完成媒体下载</label><select id="searchMediaDownloaded">',
        mediaDownloadedOptions(state.search.mediaDownloaded),
        "</select></div>",
        '<div class="field" style="margin-top:0"><label>搜索结果排序</label><select id="searchSort">',
        searchSortOptions(state.search.sort),
        "</select></div>",
        '<div class="field" style="margin-top:0"><label>发布时间起始</label><div class="date-input-row"><input id="searchStartDate" type="date" value="' + escapeHtml(state.search.startDate) + '"><button class="date-clear-button' + (state.search.startDate ? "" : " inactive") + '" type="button" data-action="clear-date" data-target="searchStartDate" ' + (state.search.startDate ? "" : "disabled") + '>清除</button></div></div>',
        '<div class="field" style="margin-top:0"><label>发布时间结束</label><div class="date-input-row"><input id="searchEndDate" type="date" value="' + escapeHtml(state.search.endDate) + '"><button class="date-clear-button' + (state.search.endDate ? "" : " inactive") + '" type="button" data-action="clear-date" data-target="searchEndDate" ' + (state.search.endDate ? "" : "disabled") + '>清除</button></div></div>',
        "</div>",
        "</section>",
        '<section class="panel"><h3>常用标签</h3><div class="top-tags">' + (topTags || '<span class="inline-muted">暂无标签</span>') + "</div></section>",
        '<section class="panel"><h3>搜索历史</h3>' + (history ? '<div class="list">' + history + "</div>" : '<p class="inline-muted">暂无搜索历史</p>') + "</section>"
      ].join("");
    }
    if (state.search.items.length) {
      results = '<section class="panel"><div class="row between"><h3>结果</h3><span class="inline-muted">' + state.search.total + " 条</span></div></section>" + renderTweetList(state.search.items);
    } else if (state.search.loading) {
      results = '<div class="loading">正在搜索...</div>';
    } else if (state.search.q) {
      results = '<div class="empty">没有匹配结果。</div>';
    }
    appEl.innerHTML = [
      controls,
      results,
      state.search.loading && state.search.items.length ? '<div class="loading">继续加载...</div>' : ""
    ].join("");
    setupMediaObserver();
    var input = document.getElementById("searchInput");
    if (input) {
      input.oninput = function () {
        state.search.q = input.value;
      };
      input.onfocus = function () {
        if (!state.search.controlsVisible) {
          state.search.controlsVisible = true;
          renderSearchPage();
          focusSearchInput();
        }
      };
      input.onkeydown = function (event) {
        if (event.key === "Enter") {
          performSearch(true);
        }
      };
    }
    bindSearchDateInputs();
  }

  function bindSearchDateInputs() {
    var startDate = document.getElementById("searchStartDate");
    var endDate = document.getElementById("searchEndDate");
    if (startDate) {
      startDate.oninput = function () {
        updateSearchDateValue("searchStartDate", "startDate", startDate.value);
      };
      startDate.onchange = function () {
        updateSearchDateValue("searchStartDate", "startDate", startDate.value);
      };
    }
    if (endDate) {
      endDate.oninput = function () {
        updateSearchDateValue("searchEndDate", "endDate", endDate.value);
      };
      endDate.onchange = function () {
        updateSearchDateValue("searchEndDate", "endDate", endDate.value);
      };
    }
  }

  function updateSearchDateValue(inputId, stateKey, value) {
    state.search[stateKey] = value || "";
    updateDateClearButton(inputId, value);
  }

  function updateDateClearButton(inputId, value) {
    var button = appEl.querySelector('[data-action="clear-date"][data-target="' + inputId + '"]');
    var hasValue = !!value;
    if (!button) {
      return;
    }
    button.classList.toggle("inactive", !hasValue);
    button.disabled = !hasValue;
  }

  function focusSearchInput() {
    setTimeout(function () {
      var input = document.getElementById("searchInput");
      if (input) {
        input.focus();
        if (input.setSelectionRange) {
          input.setSelectionRange(input.value.length, input.value.length);
        }
      }
    }, 0);
  }

  function ratingOptions(selected) {
    var html = ['<option value="0">不使用</option>'];
    for (var i = 1; i <= 5; i += 1) {
      html.push('<option value="' + i + '" ' + (Number(selected) === i ? "selected" : "") + ">" + i + " 星及以上</option>");
    }
    return html.join("");
  }

  function searchSortOptions(selected) {
    var options = [
      ["normal", "正序"],
      ["reverse", "倒序"],
      ["random", "随机排序"],
      ["created_asc", "按发布时间正序"],
      ["created_desc", "按发布时间倒序"]
    ];
    return options.map(function (item) {
      return '<option value="' + item[0] + '" ' + (selected === item[0] ? "selected" : "") + ">" + item[1] + "</option>";
    }).join("");
  }

  function mediaDownloadedOptions(selected) {
    var options = [
      ["", "不使用"],
      ["yes", "是"],
      ["no", "否"]
    ];
    return options.map(function (item) {
      return '<option value="' + item[0] + '" ' + (selected === item[0] ? "selected" : "") + ">" + item[1] + "</option>";
    }).join("");
  }

  function performSearch(reset) {
    var input = document.getElementById("searchInput");
    var archived = document.getElementById("searchArchived");
    var rating = document.getElementById("searchRating");
    var mediaDownloaded = document.getElementById("searchMediaDownloaded");
    var sort = document.getElementById("searchSort");
    var startDate = document.getElementById("searchStartDate");
    var endDate = document.getElementById("searchEndDate");
    state.search.q = input ? input.value.trim() : state.search.q;
    state.search.includeArchived = archived ? archived.checked : state.search.includeArchived;
    state.search.minRating = rating ? Number(rating.value || 0) : state.search.minRating;
    state.search.mediaDownloaded = mediaDownloaded ? mediaDownloaded.value : state.search.mediaDownloaded;
    state.search.sort = sort ? sort.value : state.search.sort;
    state.search.startDate = startDate ? startDate.value : state.search.startDate;
    state.search.endDate = endDate ? endDate.value : state.search.endDate;
    state.search.controlsVisible = false;
    if (reset) {
      state.search.items = [];
      state.search.offset = 0;
      state.search.hasMore = false;
      state.search.randomSeed = state.search.sort === "random" ? String(Date.now()) : "";
    }
    if (state.search.loading) {
      return;
    }
    if (!reset && !state.search.hasMore) {
      return;
    }
    state.search.loading = true;
    renderSearchPage();
    apiPost("/api/search", {
      q: state.search.q,
      includeArchived: state.search.includeArchived,
      minRating: state.search.minRating,
      mediaDownloaded: state.search.mediaDownloaded,
      sort: state.search.sort,
      startDate: state.search.startDate,
      endDate: state.search.endDate,
      randomSeed: state.search.randomSeed,
      offset: reset ? 0 : state.search.offset,
      limit: 50
    }).then(function (data) {
      state.search.loading = false;
      state.search.total = data.total;
      state.search.hasMore = data.hasMore;
      state.search.offset = data.offset + data.items.length;
      state.search.history = data.history || state.search.history;
      state.search.randomSeed = data.randomSeed || state.search.randomSeed;
      state.search.items = reset ? data.items : state.search.items.concat(data.items);
      renderSearchPage();
    }).catch(function (err) {
      state.search.loading = false;
      renderSearchPage();
      handleError(err);
    });
  }

  function findTweetInState(id) {
    var lists = [state.browseItems, state.search.items];
    for (var i = 0; i < lists.length; i += 1) {
      for (var j = 0; j < lists[i].length; j += 1) {
        if (String(lists[i][j].id) === String(id)) {
          return lists[i][j];
        }
      }
    }
    return null;
  }

  function updateTweetInState(tweet) {
    replaceTweet(state.browseItems, tweet);
    replaceTweet(state.search.items, tweet);
  }

  function replaceTweet(list, tweet) {
    for (var i = 0; i < list.length; i += 1) {
      if (String(list[i].id) === String(tweet.id)) {
        list[i] = tweet;
      }
    }
  }

  function findTweetCardElement(id) {
    var cards = appEl.querySelectorAll(".tweet-card");
    for (var i = 0; i < cards.length; i += 1) {
      if (String(cards[i].getAttribute("data-tweet-id")) === String(id)) {
        return cards[i];
      }
    }
    return null;
  }

  function restoreScrollPosition(x, y) {
    function restore() {
      window.scrollTo(x, y);
    }
    restore();
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(restore);
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(restore);
      });
    } else {
      setTimeout(restore, 0);
    }
  }

  function markScrollActive() {
    state.scrollQuietUntil = Date.now() + SCROLL_RENDER_DEFER_MS;
    if (Object.keys(state.pendingMediaRenders).length) {
      scheduleMediaRenderFlush();
    }
  }

  function isScrollSettling() {
    return Date.now() < state.scrollQuietUntil;
  }

  function renderTweetWhenIdle(id) {
    if (isScrollSettling()) {
      state.pendingMediaRenders[id] = true;
      scheduleMediaRenderFlush();
      return;
    }
    renderTweetInPlace(id);
  }

  function scheduleMediaRenderFlush() {
    var delay = Math.max(80, state.scrollQuietUntil - Date.now() + 80);
    if (mediaRenderFlushTimer) {
      clearTimeout(mediaRenderFlushTimer);
    }
    mediaRenderFlushTimer = setTimeout(flushPendingMediaRenders, delay);
  }

  function flushPendingMediaRenders() {
    var ids;
    var i;
    mediaRenderFlushTimer = null;
    if (isScrollSettling()) {
      scheduleMediaRenderFlush();
      return;
    }
    ids = Object.keys(state.pendingMediaRenders);
    state.pendingMediaRenders = {};
    for (i = 0; i < ids.length; i += 1) {
      renderTweetInPlace(ids[i]);
    }
  }

  function renderTweetInPlace(id) {
    var tweet = findTweetInState(id);
    var card = findTweetCardElement(id);
    var holder;
    var nextCard;
    var scrollX;
    var scrollY;
    if (!tweet || !card || !card.parentNode) {
      return;
    }
    scrollX = window.pageXOffset || document.documentElement.scrollLeft || document.body.scrollLeft || 0;
    scrollY = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
    holder = document.createElement("div");
    holder.innerHTML = renderTweetCard(tweet);
    nextCard = holder.firstChild;
    card.parentNode.replaceChild(nextCard, card);
    restoreScrollPosition(scrollX, scrollY);
  }

  function renderCurrentTweetView() {
    if (state.searchOpen) {
      renderSearchPage();
    } else if (state.activeTab === "browse") {
      renderBrowse();
    } else if (state.activeTab === "tags") {
      renderTagsPage();
    } else if (state.activeTab === "status") {
      renderStatus();
    }
  }

  function showRatingDialog(tweet) {
    var html = ["<h3>评分</h3>", '<div class="star-row">'];
    for (var i = 1; i <= 5; i += 1) {
      html.push('<button class="star-button" type="button" data-rating="' + i + '">' + (i <= (tweet.rating || 0) ? "★" : "☆") + "</button>");
    }
    html.push("</div>");
    html.push('<div class="modal-actions"><button class="button ghost" type="button" id="clearRating">清除</button><button class="button ghost" type="button" data-modal-close>关闭</button></div>');
    showModal(html.join(""), function (modal) {
      var buttons = modal.querySelectorAll("[data-rating]");
      for (var j = 0; j < buttons.length; j += 1) {
        buttons[j].onclick = function () {
          saveRating(tweet.id, Number(this.getAttribute("data-rating")));
        };
      }
      document.getElementById("clearRating").onclick = function () {
        saveRating(tweet.id, 0);
      };
    });
  }

  function saveRating(id, rating) {
    apiPost("/api/tweets/" + encodeURIComponent(id) + "/rating", { rating: rating }).then(function (tweet) {
      closeModal();
      updateTweetInState(tweet);
      renderCurrentTweetView();
    }).catch(handleError);
  }

  function showTagDialog(tweet) {
    loadTags(function () {
      var current = (tweet.tags || []).slice();
      var topTags = state.tags.slice(0, 10).map(function (item) {
        return '<button class="tag-chip" type="button" data-pick-tag="' + escapeHtml(item.tag) + '">#' + escapeHtml(item.tag) + "</button>";
      }).join("");
      var options = state.tags.map(function (item) {
        return '<option value="' + escapeHtml(item.tag) + '"></option>';
      }).join("");
      showModal([
        "<h3>标签</h3>",
        '<div id="tagEditorChips" class="tag-flow"></div>',
        '<div class="field"><label>添加标签</label><input id="tagInput" list="tagSuggestions" autocomplete="off" placeholder="输入标签后点添加"><datalist id="tagSuggestions">' + options + "</datalist></div>",
        '<div class="row" style="margin-top:10px"><button class="button secondary" type="button" id="addTagButton">添加</button></div>',
        '<div class="field"><label>常用标签</label><div class="top-tags">' + (topTags || '<span class="inline-muted">暂无标签</span>') + "</div></div>",
        '<div class="modal-actions"><button class="button ghost" type="button" data-modal-close>取消</button><button class="button" type="button" id="saveTags">保存</button></div>'
      ].join(""), function (modal) {
        function redraw() {
          var chips = document.getElementById("tagEditorChips");
          chips.innerHTML = current.length ? current.map(function (tag) {
            return '<button class="tag-chip" type="button" data-remove-tag="' + escapeHtml(tag) + '">#' + escapeHtml(tag) + " ×</button>";
          }).join("") : '<span class="inline-muted">暂无标签</span>';
        }
        function addTag(tag) {
          tag = cleanClientTag(tag);
          if (!tag) {
            return;
          }
          for (var i = 0; i < current.length; i += 1) {
            if (current[i].toLowerCase() === tag.toLowerCase()) {
              return;
            }
          }
          current.push(tag);
          redraw();
        }
        modal.onclick = function (event) {
          var target = event.target;
          var pick = target.getAttribute("data-pick-tag");
          var remove = target.getAttribute("data-remove-tag");
          if (pick) {
            addTag(pick);
          }
          if (remove) {
            current = current.filter(function (tag) {
              return tag !== remove;
            });
            redraw();
          }
        };
        document.getElementById("addTagButton").onclick = function () {
          var input = document.getElementById("tagInput");
          addTag(input.value);
          input.value = "";
          input.focus();
        };
        document.getElementById("tagInput").onkeydown = function (event) {
          if (event.key === "Enter") {
            event.preventDefault();
            document.getElementById("addTagButton").click();
          }
        };
        document.getElementById("saveTags").onclick = function () {
          apiPost("/api/tweets/" + encodeURIComponent(tweet.id) + "/tags", { tags: current }).then(function (updated) {
            closeModal();
            updateTweetInState(updated);
            renderCurrentTweetView();
          }).catch(handleError);
        };
        redraw();
      });
    });
  }

  function cleanClientTag(tag) {
    return String(tag || "").replace(/^#+/, "").replace(/\s+/g, " ").trim().slice(0, 32);
  }

  function showNoteDialog(tweet) {
    showModal([
      "<h3>备注</h3>",
      '<div class="field"><textarea id="noteInput" placeholder="写一点只保存在本地的备注">' + escapeHtml(tweet.note || "") + "</textarea></div>",
      '<div class="modal-actions"><button class="button ghost" type="button" data-modal-close>取消</button><button class="button" type="button" id="saveNote">保存</button></div>'
    ].join(""), function () {
      document.getElementById("saveNote").onclick = function () {
        apiPost("/api/tweets/" + encodeURIComponent(tweet.id) + "/note", { note: document.getElementById("noteInput").value }).then(function (updated) {
          closeModal();
          updateTweetInState(updated);
          renderCurrentTweetView();
        }).catch(handleError);
      };
    });
  }

  function showTweetMenu(tweet) {
    var archivedText = tweet.archived ? "取消归档" : "归档";
    showModal([
      "<h3>更多</h3>",
      '<div class="list">',
      '<button class="list-row" type="button" id="archiveTweet"><span>' + archivedText + "</span></button>",
      '<button class="list-row" type="button" id="showMetrics"><span>查看数据</span></button>',
      '<button class="list-row" type="button" id="refreshAuthor"><span>刷新用户名和头像</span></button>',
      '<button class="list-row" type="button" id="openTweet"><span>用浏览器或 X App 打开</span></button>',
      "</div>",
      '<div class="modal-actions"><button class="button ghost" type="button" data-modal-close>关闭</button></div>'
    ].join(""), function () {
      document.getElementById("archiveTweet").onclick = function () {
        apiPost("/api/tweets/" + encodeURIComponent(tweet.id) + "/archive", { archived: !tweet.archived }).then(function (updated) {
          closeModal();
          updateTweetInState(updated);
          renderCurrentTweetView();
        }).catch(handleError);
      };
      document.getElementById("showMetrics").onclick = function () {
        showMetrics(tweet);
      };
      document.getElementById("refreshAuthor").onclick = function () {
        refreshTweetAuthor(tweet);
      };
      document.getElementById("openTweet").onclick = function () {
        apiPost("/api/tweets/" + encodeURIComponent(tweet.id) + "/open", {}).then(function (data) {
          if (!data.openedByJsbox && data.url) {
            window.open(data.url, "_blank");
          }
          closeModal();
        }).catch(handleError);
      };
    });
  }

  function refreshTweetAuthor(tweet) {
    var author = tweet.author || {};
    var authorId = author.id || tweet.authorId || "";
    if (!authorId) {
      showToast("没有可刷新的用户 ID");
      return;
    }
    apiPost("/api/users/" + encodeURIComponent(authorId) + "/refresh", {}).then(function (data) {
      if (data && data.user) {
        updateAuthorInState(data.user);
      }
      closeModal();
      showToast("用户名和头像已刷新");
      renderCurrentTweetView();
    }).catch(handleError);
  }

  function updateAuthorInState(user) {
    updateAuthorInList(state.browseItems, user);
    updateAuthorInList(state.search.items, user);
  }

  function updateAuthorInList(list, user) {
    var i;
    var j;
    var tweet;
    var referenced;
    for (i = 0; i < list.length; i += 1) {
      tweet = list[i];
      if (String(tweet.authorId || "") === String(user.id || "") || (tweet.author && String(tweet.author.id || "") === String(user.id || ""))) {
        tweet.authorId = user.id || tweet.authorId || "";
        tweet.author = {
          id: user.id || "",
          name: user.name || "",
          username: user.username || "",
          profileImageUrl: user.profileImageUrl || "",
          verified: !!user.verified
        };
      }
      referenced = tweet.referencedTweets || [];
      for (j = 0; j < referenced.length; j += 1) {
        if (referenced[j].author && String(referenced[j].author.id || "") === String(user.id || "")) {
          referenced[j].author = {
            id: user.id || "",
            name: user.name || "",
            username: user.username || "",
            profileImageUrl: user.profileImageUrl || "",
            verified: !!user.verified
          };
        }
      }
    }
  }

  function showMetrics(tweet) {
    var metrics = tweet.publicMetrics || {};
    showModal([
      "<h3>推文数据</h3>",
      '<div class="stats-grid">',
      statHtml(formatNumber(metrics.reply_count), "评论"),
      statHtml(formatNumber(metrics.retweet_count), "转发"),
      statHtml(formatNumber(metrics.like_count), "点赞"),
      "</div>",
      '<div class="stats-grid" style="margin-top:10px">',
      statHtml(formatNumber(metrics.quote_count), "引用"),
      statHtml(formatNumber(metrics.bookmark_count), "收藏"),
      statHtml(formatNumber(metrics.impression_count), "展示"),
      "</div>",
      '<div class="modal-actions"><button class="button ghost" type="button" data-modal-close>关闭</button></div>'
    ].join(""));
  }

  function showModal(html, afterRender) {
    modalRootEl.innerHTML = '<div class="modal-backdrop"><div class="modal">' + html + "</div></div>";
    var backdrop = modalRootEl.querySelector(".modal-backdrop");
    var modal = modalRootEl.querySelector(".modal");
    backdrop.onclick = function (event) {
      if (event.target === backdrop || event.target.getAttribute("data-modal-close") !== null) {
        closeModal();
      }
    };
    if (afterRender) {
      afterRender(modal);
    }
  }

  function closeModal() {
    modalRootEl.innerHTML = "";
  }

  function showImageViewer(src, alt, ratioValue) {
    var ratio = Number(ratioValue || 1);
    var imageClass = "image-viewer-img";
    if (ratio < 0.5) {
      imageClass += " tall";
    } else if (ratio > 2) {
      imageClass += " wide";
    }
    modalRootEl.innerHTML = [
      '<div class="image-viewer-backdrop">',
      '<div class="image-viewer-stage">',
      '<img class="' + imageClass + '" src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt || "") + '">',
      "</div>",
      "</div>"
    ].join("");
    var backdrop = modalRootEl.querySelector(".image-viewer-backdrop");
    backdrop.onclick = function (event) {
      if (event.target === backdrop) {
        closeModal();
      }
    };
  }

  function onAction(action, target) {
    var id = target.getAttribute("data-id");
    if (action === "save-credentials") {
      saveCredentials();
      return;
    }
    if (action === "edit-credentials") {
      showCredentialEditor();
      return;
    }
    if (action === "refresh-token") {
      manualRefreshToken();
      return;
    }
    if (action === "sync-incremental") {
      runSync("incremental", false);
      return;
    }
    if (action === "sync-full") {
      confirmFullSync();
      return;
    }
    if (action === "random-tweet") {
      loadRandomTweet();
      return;
    }
    if (action === "browse-tag") {
      var tag = target.getAttribute("data-tag");
      state.activeTab = "browse";
      setActiveTab("browse");
      openBrowse("#" + tag, "#" + tag);
      return;
    }
    if (action === "search-add-tag") {
      addTagToSearch(target.getAttribute("data-tag"));
      return;
    }
    if (action === "search-history") {
      state.search.q = target.getAttribute("data-query") || "";
      var searchInput = document.getElementById("searchInput");
      if (searchInput) {
        searchInput.value = state.search.q;
      }
      performSearch(true);
      return;
    }
    if (action === "clear-date") {
      clearSearchDate(target.getAttribute("data-target"));
      return;
    }
    if (action === "download-long" || action === "retry-media") {
      downloadMedia(id, action === "download-long", action === "retry-media" && target.getAttribute("data-refresh-remote") === "true");
      return;
    }
    if (action === "image-viewer") {
      showImageViewer(target.getAttribute("data-src"), target.getAttribute("data-alt"), target.getAttribute("data-ratio"));
      return;
    }
    var tweet = findTweetInState(id);
    if (!tweet) {
      return;
    }
    if (action === "rate") {
      showRatingDialog(tweet);
    } else if (action === "tag") {
      showTagDialog(tweet);
    } else if (action === "note") {
      showNoteDialog(tweet);
    } else if (action === "tweet-menu") {
      showTweetMenu(tweet);
    }
  }

  function addTagToSearch(tag) {
    var input = document.getElementById("searchInput");
    var token = "#" + tag;
    var current = input ? input.value : state.search.q;
    if (current.toLowerCase().indexOf(token.toLowerCase()) === -1) {
      current = (current ? current + " " : "") + token;
    }
    state.search.q = current;
    if (input) {
      input.value = current;
      input.focus();
    }
  }

  function clearSearchDate(targetId) {
    var input = document.getElementById(targetId);
    if (targetId === "searchStartDate") {
      state.search.startDate = "";
    } else if (targetId === "searchEndDate") {
      state.search.endDate = "";
    }
    if (input) {
      input.value = "";
    }
    updateDateClearButton(targetId, "");
    state.search.controlsVisible = true;
  }

  function bindEvents() {
    tabbarEl.onclick = function (event) {
      var button = closestAction(event.target);
      if (button) {
        return;
      }
      var target = event.target;
      while (target && target !== tabbarEl) {
        if (target.getAttribute && target.getAttribute("data-tab")) {
          var tab = target.getAttribute("data-tab");
          if (!state.searchOpen && state.activeTab === tab) {
            scrollToTop();
          } else {
            navigate(tab);
          }
          return;
        }
        target = target.parentNode;
      }
    };

    appEl.onclick = function (event) {
      var actionEl = closestAction(event.target);
      if (!actionEl) {
        return;
      }
      event.preventDefault();
      onAction(actionEl.getAttribute("data-action"), actionEl);
    };

    window.addEventListener("scroll", function () {
      markScrollActive();
      var nearBottom = window.innerHeight + window.pageYOffset > document.body.offsetHeight - 420;
      if (!nearBottom) {
        return;
      }
      if (state.searchOpen) {
        performSearch(false);
      } else if (state.activeTab === "browse") {
        loadBrowse(false);
      }
    });
  }

  bindEvents();
  navigate("status");
}());
