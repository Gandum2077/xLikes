"use strict";

var assert = require("assert");
var axios = require("axios");
var low = require("lowdb");
var Memory = require("lowdb/adapters/Memory");
var router = require("../routes/api");
var db = low(new Memory());
var relikedId = "2100811705735590174";
var date = "2026-09-18T04:58:36.000Z";
var originalAdapter = axios.defaults.adapter;

function resetDb(tweets, syncState) {
  db.setState({
    settings: { userId: "1", syncPageSize: 5 },
    sync: syncState || {},
    tweets: typeof tweets !== "undefined" ? tweets : [
      { id: "1003", sortOrder: 30, localCreatedAt: date },
      { id: "1002", sortOrder: 29, localCreatedAt: date },
      { id: relikedId, sortOrder: 28, localCreatedAt: date, tags: ["kept"], note: "keep me" }
    ]
  }).write();
}

// Replace the entire transport: these tests never contact X or spend credits.
function mockPages(pages) {
  var requested = [];
  axios.defaults.adapter = function (config) {
    assert.strictEqual(config.url, "https://api.x.com/2/users/1/liked_tweets");
    var token = config.params.pagination_token || "";
    var page = pages[token];
    requested.push(token);
    assert.ok(page, "Unexpected pagination token: " + token);
    if (page.rateLimited || page.errorStatus) {
      var err = new Error("Mock X error");
      err.response = { status: page.errorStatus || 429, data: {}, headers: page.headers || {} };
      return Promise.reject(err);
    }
    return Promise.resolve({
      status: 200,
      headers: page.headers || {},
      data: {
        data: page.ids.map(function (id) {
          return { id: id, text: id, created_at: date };
        }),
        meta: { next_token: page.next, result_count: page.ids.length }
      }
    });
  };
  return requested;
}

// Dispatch actual Express routes with a private in-memory lowdb instance.
function dispatch(method, routePath, body) {
  var route = router.stack.find(function (layer) {
    return layer.route && layer.route.path === routePath && layer.route.methods[method.toLowerCase()];
  }).route;
  return new Promise(function (resolve) {
    var req = { method: method, app: { locals: { db: db } }, body: body || {} };
    var res = {
      statusCode: 200,
      status: function (code) { this.statusCode = code; return this; },
      json: function (responseBody) { resolve({ status: this.statusCode, body: responseBody }); }
    };
    route.dispatch(req, res, function (err) {
      resolve({ status: err ? err.statusCode || 500 : 404, error: err });
    });
  });
}

function sync(mode, extraBody) {
  return dispatch("POST", "/sync", Object.assign({ mode: mode }, extraBody || {}));
}

function successful(result) {
  assert.strictEqual(result.status, 200, result.error && result.error.stack);
  assert.strictEqual(result.body.ok, true);
  return result.body.data;
}

function assertPagePause(summary) {
  assert.strictEqual(summary.paused, true);
  assert.strictEqual(summary.pauseReason, "page_limit");
  assert.strictEqual(summary.maxPagesPerRun, 10);
  assert.strictEqual(summary.pagesThisRun, 10);
  assert.strictEqual(summary.stoppedByDuplicate, false);
  assert.ok(db.get("sync.resume").value());
}

// Distinct new records keep the stop condition unsatisfied until a chosen page.
function newPageChain(count) {
  var pages = {};
  for (var i = 0; i < count; i += 1) {
    pages[i ? "page-" + i : ""] = { ids: [String(2000 + i)], next: "page-" + (i + 1) };
  }
  return pages;
}

function pageTokens(count) {
  var tokens = [];
  for (var i = 0; i < count; i += 1) { tokens.push(i ? "page-" + i : ""); }
  return tokens;
}

var tests = [];
function test(name, fn) { tests.push({ name: name, run: fn }); }

test("one new Tweet followed by known Tweets stops in one request", async function () {
  resetDb();
  db.get("tweets").push({ id: "1001", sortOrder: 27, localCreatedAt: date }).write();
  var requested = mockPages({ "": { ids: ["1006", "1003", "1002", relikedId, "1001"], next: "must-not-request" } });
  var summary = successful(await sync("incremental"));
  assert.deepStrictEqual(requested, [""]);
  assert.strictEqual(summary.pages, 1);
  assert.strictEqual(summary.added, 1);
  assert.strictEqual(summary.updated, 0);
  assert.strictEqual(summary.stoppedByDuplicate, true);
  assert.strictEqual(summary.paused, false);
  assert.strictEqual(db.get("sync.resume").value(), null);
  assert.strictEqual(db.get("tweets").find({ id: "1003" }).value().sortOrder, 30);
});

test("missing or reordered old leading Tweets cannot cause a historical scan", async function () {
  resetDb(undefined, { incrementalBoundary: ["1003", "no-longer-liked"] });
  var requested = mockPages({ "": { ids: ["1006", "1002", relikedId], next: "must-not-request" } });
  var summary = successful(await sync("incremental"));
  assert.deepStrictEqual(requested, [""]);
  assert.strictEqual(summary.added, 1);
  assert.strictEqual(summary.stoppedByDuplicate, true);
});

test("an isolated relike preserves later new Tweets while automatically matching across pages", async function () {
  resetDb();
  var requested = mockPages({
    "": { ids: ["1006", relikedId, "1005", "1004", "1003"], next: "next" },
    next: { ids: ["1002", "1001"], next: "must-not-request" }
  });
  var summary = successful(await sync("incremental"));
  assert.deepStrictEqual(requested, ["", "next"]);
  assert.strictEqual(summary.pages, 2);
  assert.strictEqual(summary.pagesThisRun, 2);
  assert.strictEqual(summary.added, 3);
  assert.strictEqual(summary.updated, 1);
  assert.strictEqual(summary.stoppedByDuplicate, true);
  assert.strictEqual(summary.paused, false);
  assert.strictEqual(db.get("sync.resume").value(), null);
  assert.deepStrictEqual(db.get("tweets").value().map(function (tweet) { return tweet.id; }).sort(),
    ["1002", "1003", "1004", "1005", "1006", relikedId]);
  var reliked = db.get("tweets").find({ id: relikedId }).value();
  assert.deepStrictEqual(reliked.tags, ["kept"]);
  assert.strictEqual(reliked.note, "keep me");
  assert.strictEqual(reliked.localCreatedAt, date);
  assert.ok(reliked.sortOrder > 30);
  assert.strictEqual(db.get("tweets").find({ id: "1003" }).value().sortOrder, 30);
});

test("multiple pages of new Tweets finish with one click and stop as soon as history is reached", async function () {
  resetDb();
  var requested = mockPages({
    "": { ids: ["1009", "1008"], next: "next" },
    next: { ids: ["1007", "1006"], next: "third" },
    third: { ids: ["1005", "1003", "1002"], next: "must-not-request" }
  });
  var summary = successful(await sync("incremental", { maxPagesPerRun: 1 }));
  assert.deepStrictEqual(requested, ["", "next", "third"]);
  assert.strictEqual(summary.added, 5);
  assert.strictEqual(summary.pagesThisRun, 3);
  assert.strictEqual(summary.stoppedByDuplicate, true);
  assert.strictEqual(summary.paused, false);
  assert.strictEqual(db.get("sync.resume").value(), null);
});

test("incremental operations automatically read up to ten pages and client budgets cannot bypass protection", async function () {
  resetDb();
  var pages = newPageChain(22);
  pages["page-22"] = { ids: ["1003", "1002"], next: "must-not-request" };
  var requested = mockPages(pages);
  var summary = successful(await sync("incremental", { maxPagesPerRun: 1000 }));
  assertPagePause(summary);
  assert.deepStrictEqual(requested, pageTokens(10));
  assert.strictEqual(summary.pages, 10);
  assert.strictEqual(summary.added, 10);
  summary = successful(await sync("resume", { maxPagesPerRun: 1000 }));
  assertPagePause(summary);
  assert.deepStrictEqual(requested, pageTokens(20));
  assert.strictEqual(summary.pages, 20);
  assert.strictEqual(summary.added, 20);
  summary = successful(await sync("resume"));
  assert.deepStrictEqual(requested, pageTokens(23));
  assert.strictEqual(summary.pages, 23);
  assert.strictEqual(summary.pagesThisRun, 3);
  assert.strictEqual(summary.added, 22);
  assert.strictEqual(summary.stoppedByDuplicate, true);
  assert.strictEqual(summary.paused, false);
  assert.strictEqual(db.get("sync.resume").value(), null);
});

test("resumes retain the original known snapshot rather than this run's newly saved Tweets", async function () {
  resetDb();
  var pages = newPageChain(10);
  pages["page-10"] = { ids: ["2000", "2001", "1006"], next: "page-11" };
  pages["page-11"] = { ids: ["1003", "1002"], next: "must-not-request" };
  var requested = mockPages(pages);
  assertPagePause(successful(await sync("incremental")));
  var resume = db.get("sync.resume").value();
  assert.strictEqual(resume.version, 2);
  assert.deepStrictEqual(resume.knownTweetIds.slice().sort(), ["1002", "1003", relikedId]);
  var summary = successful(await sync("resume"));
  assert.deepStrictEqual(requested, pageTokens(12));
  assert.strictEqual(summary.pagesThisRun, 2);
  assert.strictEqual(summary.stoppedByDuplicate, true);
  assert.strictEqual(summary.added, 11);
  assert.strictEqual(summary.updated, 2);
});

test("automatic pagination preserves pending matches when rate limited and resumes at the interrupted page", async function () {
  resetDb();
  var pages = {
    "": { ids: ["1006", "1005", "1004", "1003"], next: "next" },
    next: { rateLimited: true }
  };
  var requested = mockPages(pages);
  assert.strictEqual((await sync("incremental")).status, 429);
  assert.deepStrictEqual(requested, ["", "next"]);
  var resume = db.get("sync.resume").value();
  assert.strictEqual(resume.version, 2);
  assert.strictEqual(resume.pendingKnownTweet.id, "1003");
  assert.deepStrictEqual(resume.knownTweetIds.slice().sort(), ["1002", "1003", relikedId]);
  pages.next = { ids: ["1002", "1001"], next: "must-not-request" };
  var summary = successful(await sync("resume"));
  assert.deepStrictEqual(requested, ["", "next", "next"]);
  assert.strictEqual(summary.added, 3);
  assert.strictEqual(summary.updated, 0);
  assert.strictEqual(summary.stoppedByDuplicate, true);
});

test("the rate-limit reset blocks early resumes without another paid request", async function () {
  resetDb();
  var reset = String(Math.ceil(Date.now() / 1000) + 3600);
  var pages = {
    "": { ids: ["1006"], next: "next" },
    next: { rateLimited: true, headers: { "x-rate-limit-reset": reset, "x-rate-limit-remaining": "0" } }
  };
  var requested = mockPages(pages);
  assert.strictEqual((await sync("incremental")).status, 429);
  assert.strictEqual((await sync("resume")).status, 429);
  assert.deepStrictEqual(requested, ["", "next"]);
});

test("new incremental and full requests cannot bypass an existing rate-limit reset", async function () {
  resetDb();
  var reset = String(Math.ceil(Date.now() / 1000) + 3600);
  var pages = {
    "": { ids: ["1006"], next: "next" },
    next: { rateLimited: true, headers: { "x-rate-limit-reset": reset, "x-rate-limit-remaining": "0" } }
  };
  var requested = mockPages(pages);
  assert.strictEqual((await sync("incremental")).status, 429);
  var savedResume = JSON.stringify(db.get("sync.resume").value());
  assert.strictEqual((await sync("incremental")).status, 429);
  assert.strictEqual((await sync("full")).status, 429);
  assert.strictEqual((await sync("resume")).status, 429);
  assert.deepStrictEqual(requested, ["", "next"]);
  assert.strictEqual(JSON.stringify(db.get("sync.resume").value()), savedResume);
});

test("remaining zero pauses full sync before it sends a doomed follow-up request", async function () {
  resetDb();
  var reset = String(Math.ceil(Date.now() / 1000) + 3600);
  var requested = mockPages({
    "": { ids: ["1006"], next: "next", headers: { "x-rate-limit-remaining": "0", "x-rate-limit-reset": reset } }
  });
  var summary = successful(await sync("full"));
  assert.deepStrictEqual(requested, [""]);
  assert.strictEqual(summary.paused, true);
  assert.strictEqual(summary.pauseReason, "rate_limit");
  assert.strictEqual(db.get("sync.resume").value().rateLimitReset, reset);
  assert.strictEqual((await sync("resume")).status, 429);
  assert.deepStrictEqual(requested, [""]);
});

test("non-429 resume errors preserve the checkpoint instead of losing saved progress", async function () {
  resetDb();
  var pages = { "": { ids: ["1006", "1003"], next: "next" }, next: { errorStatus: 503 } };
  var requested = mockPages(pages);
  var result = await sync("incremental");
  assert.ok(result.status >= 400);
  assert.strictEqual(db.get("sync.resume").value().pauseReason, "request_error");
  assert.strictEqual(db.get("sync.resume").value().pendingKnownTweet.id, "1003");
  pages.next = { ids: ["1002"], next: "must-not-request" };
  var summary = successful(await sync("resume"));
  assert.deepStrictEqual(requested, ["", "next", "next"]);
  assert.strictEqual(summary.added, 1);
  assert.strictEqual(summary.stoppedByDuplicate, true);
});

test("one known Tweet is enough to end an incremental sync", async function () {
  resetDb([{ id: "1003", localCreatedAt: date }]);
  var requested = mockPages({ "": { ids: ["1006", "1003"], next: "must-not-request" } });
  var summary = successful(await sync("incremental"));
  assert.deepStrictEqual(requested, [""]);
  assert.strictEqual(summary.added, 1);
  assert.strictEqual(summary.stoppedByDuplicate, true);
});

test("a one-record library still saves new Tweets after the known Tweet on the same page", async function () {
  resetDb([{ id: "1003", localCreatedAt: date }]);
  var requested = mockPages({
    "": { ids: ["1003", "1006", "1005"], next: "next" },
    next: { ids: ["1004", "1003"], next: "must-not-request" }
  });
  var summary = successful(await sync("incremental"));
  assert.deepStrictEqual(requested, ["", "next"]);
  assert.strictEqual(summary.added, 3);
  assert.ok(db.get("tweets").find({ id: "1006" }).value());
  assert.ok(db.get("tweets").find({ id: "1005" }).value());
  assert.ok(db.get("tweets").find({ id: "1004" }).value());
  assert.strictEqual(summary.stoppedByDuplicate, true);
});

test("empty libraries automatically collect multiple pages without falsely matching newly saved records", async function () {
  resetDb([]);
  var requested = mockPages({
    "": { ids: ["1006", "1005"], next: "next" },
    next: { ids: ["1006", "1005", "1004"] }
  });
  var summary = successful(await sync("incremental"));
  assert.deepStrictEqual(requested, ["", "next"]);
  assert.strictEqual(summary.added, 3);
  assert.strictEqual(summary.stoppedByDuplicate, false);
  assert.strictEqual(summary.paused, false);
  assert.strictEqual(db.get("sync.resume").value(), null);
});

test("legacy records without sortOrder can still stop an incremental sync", async function () {
  resetDb([{ id: "1003", localCreatedAt: date }, { id: "1002", localCreatedAt: date }]);
  var requested = mockPages({ "": { ids: ["1006", "1003", "1002"], next: "must-not-request" } });
  assert.strictEqual(successful(await sync("incremental")).stoppedByDuplicate, true);
  assert.deepStrictEqual(requested, [""]);
});

test("legacy incremental resumes discard deep cursors and safely recheck the first page", async function () {
  resetDb(undefined, {
    incrementalBoundary: ["missing-a", "missing-b"],
    resume: { mode: "incremental", paginationToken: "legacy-deep", pageSize: 5, pages: 40, added: 1, updated: 199 }
  });
  var requested = mockPages({ "": { ids: ["1006", "1003", "1002"], next: "must-not-request" } });
  assert.strictEqual(successful(await dispatch("GET", "/status")).sync.resume.restartRequired, true);
  var summary = successful(await sync("resume"));
  assert.deepStrictEqual(requested, [""]);
  assert.strictEqual(summary.restartedFromLegacy, true);
  assert.strictEqual(summary.pages, 1);
  assert.strictEqual(summary.added, 1);
  assert.strictEqual(summary.updated, 0);
  assert.strictEqual(summary.stoppedByDuplicate, true);
});

test("version-two checkpoints from the one-page release now automatically continue across multiple pages", async function () {
  resetDb(undefined, {
    resume: {
      version: 2,
      mode: "incremental",
      paginationToken: "old-next",
      visitedPaginationTokens: ["", "old-next"],
      knownTweetIds: ["1003", "1002", relikedId],
      pageSize: 5,
      pages: 1,
      added: 1,
      updated: 0,
      sequence: 1,
      startedAt: date,
      pauseReason: "page_limit",
      maxPagesPerRun: 1
    }
  });
  db.get("tweets").push({ id: "1006", sortOrder: 31, localCreatedAt: date }).write();
  var requested = mockPages({
    "old-next": { ids: ["1005"], next: "middle" },
    middle: { ids: ["1004", "1003"], next: "last" },
    last: { ids: ["1002"], next: "must-not-request" }
  });
  var summary = successful(await sync("resume"));
  assert.deepStrictEqual(requested, ["old-next", "middle", "last"]);
  assert.strictEqual(summary.resumed, true);
  assert.strictEqual(summary.restartedFromLegacy, false);
  assert.strictEqual(summary.maxPagesPerRun, 10);
  assert.strictEqual(summary.pages, 4);
  assert.strictEqual(summary.pagesThisRun, 3);
  assert.strictEqual(summary.added, 3);
  assert.strictEqual(summary.stoppedByDuplicate, true);
  assert.strictEqual(summary.paused, false);
  assert.strictEqual(db.get("sync.resume").value(), null);
});

test("a fresh incremental request replaces even a modern saved resume", async function () {
  resetDb(undefined, {
    incrementalBoundary: ["missing-a", "missing-b"],
    resume: { version: 2, mode: "incremental", paginationToken: "old-deep", knownTweetIds: [], pageSize: 5, pages: 40, added: 1, updated: 199 }
  });
  var requested = mockPages({ "": { ids: ["1006", "1003", "1002"], next: "must-not-request" } });
  var summary = successful(await sync("incremental"));
  assert.deepStrictEqual(requested, [""]);
  assert.strictEqual(summary.pages, 1);
  assert.strictEqual(summary.added, 1);
  assert.strictEqual(summary.stoppedByDuplicate, true);
});

test("repeated copies of one known ID cannot count as two distinct old records", async function () {
  resetDb();
  var requested = mockPages({
    "": { ids: ["1006", "1003", "1003"], next: "next" },
    next: { ids: ["1002"], next: "must-not-request" }
  });
  var summary = successful(await sync("incremental"));
  assert.strictEqual(summary.stoppedByDuplicate, true);
  assert.strictEqual(summary.pagesThisRun, 2);
  assert.deepStrictEqual(requested, ["", "next"]);
});

test("an empty page with another cursor pauses without persisting a looping resume", async function () {
  resetDb();
  var requested = mockPages({ "": { ids: [], next: "loop" } });
  var summary = successful(await sync("incremental"));
  assert.deepStrictEqual(requested, [""]);
  assert.strictEqual(summary.paused, true);
  assert.strictEqual(summary.pauseReason, "pagination_stalled");
  assert.strictEqual(db.get("sync.resume").value(), null);
});

test("a repeated cursor stops before another paid request and removes the looping resume", async function () {
  resetDb();
  var requested = mockPages({ "": { ids: ["1006"], next: "loop" }, loop: { ids: ["1005"], next: "loop" } });
  var summary = successful(await sync("incremental"));
  assert.deepStrictEqual(requested, ["", "loop"]);
  assert.strictEqual(summary.paused, true);
  assert.strictEqual(summary.pauseReason, "pagination_stalled");
  assert.strictEqual(db.get("sync.resume").value(), null);
});

test("longer cursor cycles are detected across separate incremental operations", async function () {
  resetDb();
  var pages = newPageChain(10);
  pages["page-10"] = { ids: ["1006"], next: "page-2" };
  var requested = mockPages(pages);
  assertPagePause(successful(await sync("incremental")));
  var summary = successful(await sync("resume"));
  assert.deepStrictEqual(requested, pageTokens(11));
  assert.strictEqual(summary.paused, true);
  assert.strictEqual(summary.pauseReason, "pagination_stalled");
  assert.strictEqual(db.get("sync.resume").value(), null);
});

test("public status exposes the pause budget but hides cursors and known snapshots", async function () {
  resetDb();
  var pages = newPageChain(10);
  pages["page-9"] = { ids: ["2009", "1003"], next: "private-next-token" };
  mockPages(pages);
  assertPagePause(successful(await sync("incremental")));
  var status = successful(await dispatch("GET", "/status"));
  var resume = status.sync.resume;
  assert.strictEqual(resume.pauseReason, "page_limit");
  assert.strictEqual(resume.maxPagesPerRun, 10);
  assert.strictEqual(resume.restartRequired, false);
  ["paginationToken", "knownTweetIds", "pendingKnownTweet", "visitedPaginationTokens"].forEach(function (key) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(resume, key), false);
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(status.sync, "incrementalBoundary"), false);
  assert.strictEqual(JSON.stringify(status).indexOf("private-next-token"), -1);
});

test("explicit full sync still traverses pages and updates known Tweets", async function () {
  resetDb();
  var requested = mockPages({
    "": { ids: ["1006", "1003", "1002"], next: "next" },
    next: { ids: [relikedId] }
  });
  var summary = successful(await sync("full"));
  assert.deepStrictEqual(requested, ["", "next"]);
  assert.strictEqual(summary.mode, "full");
  assert.strictEqual(summary.pages, 2);
  assert.strictEqual(summary.added, 1);
  assert.strictEqual(summary.updated, 3);
  assert.strictEqual(summary.stoppedByDuplicate, false);
  assert.strictEqual(summary.paused, false);
  assert.strictEqual(db.get("sync.resume").value(), null);
});

test("full-sync rate-limit resumes retain full mode and the saved cursor", async function () {
  resetDb();
  var pages = { "": { ids: ["1006", "1003"], next: "next" }, next: { rateLimited: true } };
  var requested = mockPages(pages);
  assert.strictEqual((await sync("full")).status, 429);
  assert.deepStrictEqual(requested, ["", "next"]);
  pages.next = { ids: ["1002", relikedId] };
  var summary = successful(await sync("resume"));
  assert.deepStrictEqual(requested, ["", "next", "next"]);
  assert.strictEqual(summary.mode, "full");
  assert.strictEqual(summary.pages, 2);
  assert.strictEqual(summary.added, 1);
  assert.strictEqual(summary.updated, 3);
  assert.strictEqual(summary.stoppedByDuplicate, false);
});

async function run() {
  var failed = [];
  for (var i = 0; i < tests.length; i += 1) {
    try { await tests[i].run(); }
    catch (err) { failed.push(tests[i].name + "\n" + err.stack); }
  }
  assert.strictEqual(failed.length, 0, failed.join("\n\n"));
  console.log("sync tests passed (" + tests.length + " scenarios; no network requests)");
}

process.env.X_ACCESS_TOKEN = "sync-fixture-token";
run().then(function () {
  axios.defaults.adapter = originalAdapter;
}, function (err) {
  axios.defaults.adapter = originalAdapter;
  console.error(err);
  process.exitCode = 1;
});
