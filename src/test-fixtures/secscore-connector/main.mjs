const DEFAULT_SERVER_URL = "https://secscore-api.sectl.cn";
const SKILL_PATH = "skills/secscore";
const PAGE_ID = "secscore";
// SecScore requests must load the complete Skill before the model chooses a
// tool. Keep the matcher tolerant of natural Chinese phrasing and English
// product names, including 加分/减分/扣分 variants.
const SCORE_AMOUNT_PATTERN = "(?:[+-]?(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万亿]+))";
const SKILL_AUTO_LOAD_PATTERN = new RegExp(`SecScore|Sec\\s*Score|积分|加(?:\\s*${SCORE_AMOUNT_PATTERN}\\s*)?分|加点|奖励(?:\\s*${SCORE_AMOUNT_PATTERN}\\s*)?分|减(?:\\s*${SCORE_AMOUNT_PATTERN}\\s*)?分|扣(?:\\s*${SCORE_AMOUNT_PATTERN}\\s*)?分|扣点|罚分|积分榜|积分查询`, "iu");

const serverUrl = () => (process.env.SECSCORE_SYNC_SERVER_URL || process.env.SECSCORE_SYNC_API_URL || DEFAULT_SERVER_URL).replace(/\/$/, "");
const newId = () => crypto.randomUUID();
const normalized = (value) => String(value ?? "").trim();

function deterministicStudentId(name) {
  let hash = 2166136261;
  for (const char of name) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  return `${hex}-0000-5000-8000-${hex}${hex.slice(0, 4)}`;
}

export async function activate(api) {
  const accounts = new Map();
  const classesByAccount = new Map();
  const savedConfig = api.getConfig();
  const selected = {
    accountId: normalized(savedConfig.accountId),
    classId: normalized(savedConfig.classId),
  };
  const saveSelection = () => api.setConfig({ accountId: selected.accountId, classId: selected.classId });
  const devices = new Map();
  const counters = new Map();
  let registered = false;
  let currentSession = null;

  const request = async (path, token, init = {}) => {
    if (!token) throw new Error("没有可用的 SECTL 登录态，请先在 SecScore 操作设置页登录");
    const response = await api.fetch(`${serverUrl()}${path}`, {
      ...init,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || payload?.detail || `SecScore 云端请求失败（HTTP ${response.status}）`);
    return payload;
  };

  const normalizeSession = async (session) => {
    if (!session?.accessToken) return null;
    const relayUrl = (process.env.SECTL_OFFICIAL_API_URL || "").replace(/\/$/, "");
    const clientId = process.env.SECTL_OFFICIAL_CLIENT_ID || "";
    const platformId = process.env.SECTL_OFFICIAL_PLATFORM_ID || clientId;
    if (!relayUrl || !clientId) return session;
    const introspection = await api.fetch(`${relayUrl}/auth/introspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: session.accessToken, client_id: clientId }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    const introspectionPayload = introspection ? await introspection.json().catch(() => ({})) : {};
    if (introspection?.ok && introspectionPayload?.active === true && introspectionPayload?.user_id) {
      return { ...session, userId: session.userId || introspectionPayload.user_id, email: session.email || introspectionPayload.email, name: session.name || introspectionPayload.name };
    }
    const exchange = await api.fetch(`${relayUrl}/auth/oauth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: session.accessToken, client_id: clientId, platform_id: platformId }),
      signal: AbortSignal.timeout(15000),
    });
    const exchangePayload = await exchange.json().catch(() => ({}));
    if (!exchange.ok || !exchangePayload?.access_token) throw new Error(exchangePayload?.detail || "无法将 SECTL 登录态转换为官方 Relay 登录态");
    return { accessToken: exchangePayload.access_token, userId: exchangePayload.user?.id, email: exchangePayload.user?.email, name: exchangePayload.user?.name };
  };

  const refreshCurrentSession = async () => {
    const rawSession = await api.getSectlSession().catch(() => null);
    const session = await normalizeSession(rawSession);
    currentSession = session;
    if (!session?.accessToken) return null;
    const id = session.userId || session.email || "current";
    const existing = accounts.get(id);
    accounts.set(id, { id, email: session.email || "", name: session.name || session.email || "当前登录账号", accessToken: session.accessToken, source: existing?.source || "current" });
    if (!selected.accountId || !accounts.has(selected.accountId)) {
      selected.accountId = id;
      selected.classId = "";
    }
    saveSelection();
    return session;
  };

  const accountView = (account) => ({ id: account.id, email: account.email, name: account.name, source: account.source });
  const activeAccount = (accountId) => {
    const id = normalized(accountId) || selected.accountId;
    const account = accounts.get(id);
    if (!account) throw new Error("尚未选择 SecScore 账号，请先在设置页选择或登录账号");
    selected.accountId = id;
    saveSelection();
    return account;
  };
  const classesFor = (account) => classesByAccount.get(account.id) || [];
  const activeClass = (accountId, classId) => {
    const account = activeAccount(accountId);
    const id = normalized(classId) || selected.classId;
    const item = classesFor(account).find((entry) => entry.id === id);
    if (!item) throw new Error("尚未选择班级，请先在 SecScore 操作设置页选择班级");
    selected.classId = id;
    saveSelection();
    return { account, class: item };
  };
  const loadClasses = async (accountId) => {
    const account = activeAccount(accountId);
    const classes = await request("/v1/classes", account.accessToken);
    const list = Array.isArray(classes) ? classes : classes.classes;
    const value = (Array.isArray(list) ? list : []).filter((item) => item && typeof item === "object").map((item) => ({ ...item, id: normalized(item.id) })).filter((item) => item.id);
    classesByAccount.set(account.id, value);
    if (!value.some((item) => item.id === selected.classId)) selected.classId = value[0]?.id || "";
    saveSelection();
    return value;
  };
  const deviceFor = (accountId, classId) => {
    const key = `${accountId}:${classId}`;
    if (!devices.has(key)) devices.set(key, newId());
    return devices.get(key);
  };
  const nextCounter = (accountId, classId) => {
    const key = `${accountId}:${classId}`;
    const value = (counters.get(key) || 0) + 1;
    counters.set(key, value);
    return value;
  };

  const readClass = async (accountId, classId) => {
    const { account, class: classInfo } = activeClass(accountId, classId);
    const snapshotResponse = await request(`/v1/snapshot?class_id=${encodeURIComponent(classInfo.id)}`, account.accessToken);
    const snapshot = snapshotResponse?.snapshot || {};
    const syncResponse = await request("/v1/sync", account.accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ class_id: classInfo.id, device_id: deviceFor(account.id, classInfo.id), last_server_change_seq: 0, operations: [], limit: 2000 }),
    });
    const balances = new Map((syncResponse?.balances || []).map((item) => [item.student_id, item]));
    const students = (Array.isArray(snapshot.students) ? snapshot.students : []).map((student) => {
      const name = normalized(student.name || student.student_name);
      const studentId = deterministicStudentId(name);
      const balance = balances.get(studentId);
      return {
        student_id: studentId,
        name,
        group_name: normalized(student.group_name || student.group || "") || null,
        score: Number(balance?.score ?? student.score ?? 0),
        reward_points: Number(balance?.reward_points ?? student.reward_points ?? 0),
      };
    }).filter((student) => student.name);
    return { account, class: classInfo, students, snapshot, serverChangeSeq: syncResponse?.server_change_seq || 0 };
  };

  const findStudent = async (args = {}) => {
    const data = await readClass(args.account_id, args.class_id);
    const query = normalized(args.query || args.student_name);
    const exact = data.students.filter((student) => student.name === query);
    const matches = exact.length ? exact : data.students.filter((student) => student.name.includes(query));
    return { data, matches };
  };

  const listStudents = async (args = {}) => {
    const { students, class: classInfo } = await readClass(args.account_id, args.class_id);
    const query = normalized(args.query || args.student_name);
    const group = normalized(args.group_name || args.group);
    const limit = Math.min(Math.max(Number(args.limit || 1000), 1), 2000);
    return { class: { id: classInfo.id, name: classInfo.name }, students: students.filter((student) => (!query || student.name.includes(query)) && (!group || student.group_name === group)).slice(0, limit) };
  };

  const callAction = async (action, args = {}) => {
    if (action === "get_state") {
      await refreshCurrentSession().catch(() => null);
      const account = selected.accountId ? accounts.get(selected.accountId) : null;
      const classes = account ? (classesFor(account).length ? classesFor(account) : await loadClasses(account.id).catch(() => [])) : [];
      return { serverUrl: serverUrl(), accounts: [...accounts.values()].map(accountView), selectedAccountId: selected.accountId, selectedClassId: selected.classId, classes, hasCurrentSession: Boolean(currentSession?.accessToken) };
    }
    if (action === "oauth_login") {
      const session = await normalizeSession(await api.sectlOAuthLogin());
      const id = session.userId || session.email || newId();
      accounts.set(id, { id, email: session.email || "", name: session.name || session.email || "SECTL 账号", accessToken: session.accessToken, source: "oauth" });
      selected.accountId = id;
      selected.classId = "";
      const classes = await loadClasses(id);
      return { account: accountView(accounts.get(id)), classes, selectedAccountId: id, selectedClassId: selected.classId };
    }
    if (action === "select_account") {
      const account = activeAccount(args.account_id);
      selected.classId = "";
      const classes = await loadClasses(account.id);
      saveSelection();
      return { classes, selectedAccountId: account.id, selectedClassId: selected.classId };
    }
    if (action === "list_classes") return { classes: await loadClasses(args.account_id) };
    if (action === "select_class") {
      const account = activeAccount(args.account_id);
      const classes = classesFor(account).length ? classesFor(account) : await loadClasses(account.id);
      const item = classes.find((entry) => entry.id === normalized(args.class_id));
      if (!item) throw new Error("找不到所选班级");
      selected.classId = item.id;
      saveSelection();
      return { class: item, selectedAccountId: account.id, selectedClassId: item.id };
    }
    if (action === "refresh") {
      const account = activeAccount(args.account_id);
      const classes = await loadClasses(account.id);
      return { accounts: [...accounts.values()].map(accountView), classes, selectedAccountId: account.id, selectedClassId: selected.classId };
    }
    if (action === "remove_account") {
      const id = normalized(args.account_id);
      if (id && accounts.get(id)?.source !== "current") accounts.delete(id);
      if (!accounts.has(selected.accountId)) { selected.accountId = [...accounts.keys()][0] || ""; selected.classId = ""; }
      saveSelection();
      return callAction("get_state");
    }
    throw new Error(`未知的 SecScore 设置操作：${action}`);
  };

  const addScore = async (args = {}) => {
    const score = Number(args.score ?? args.delta);
    const reason = normalized(args.reason || args.reason_content);
    const studentName = normalized(args.student_name || args.studentName);
    if (!Number.isInteger(score) || score === 0) throw new Error("score 必须是非零整数，可用负数表示扣分");
    if (!reason) throw new Error("reason 不能为空");
    if (!studentName) throw new Error("student_name 不能为空");
    const { data, matches } = await findStudent({ ...args, query: studentName });
    if (matches.length !== 1) throw new Error(matches.length ? `找到多个同名或相似同学：${matches.map((item) => item.name).join("、")}，请提供更完整姓名` : `找不到同学：${studentName}`);
    const student = matches[0];
    const clientSeq = nextCounter(data.account.id, data.class.id);
    const operationId = newId();
    const response = await request("/v1/operations", data.account.accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": operationId },
      body: JSON.stringify({
        class_id: data.class.id,
        device_id: deviceFor(data.account.id, data.class.id),
        last_server_change_seq: data.serverChangeSeq,
        operation: {
          op_id: operationId,
          client_seq: clientSeq,
          lamport: clientSeq,
          entity_type: "student",
          entity_id: student.student_id,
          operation_type: "score.adjust",
          payload: { student_name: student.name, reason_content: reason, score_delta: score, reward_delta: score },
          client_created_at: new Date().toISOString(),
        },
      }),
    });
    const balance = (response.balances || []).find((item) => item.student_id === student.student_id);
    return { ok: true, operation_id: operationId, class: { id: data.class.id, name: data.class.name }, student: student.name, student_id: student.student_id, score_delta: score, reason, previous_score: student.score, current_score: Number(balance?.score ?? student.score + score), server_change_seq: response.accepted_operations?.[0]?.server_change_seq || response.server_change_seq };
  };

  api.registerTool({ name: "add_score", description: "在当前选定的 SecScore 班级中给一名同学加分或扣分，并将操作直接同步到云端。", hidden: false, inputSchema: { type: "object", additionalProperties: false, required: ["student_name", "score", "reason"], properties: { student_name: { type: "string", description: "同学完整姓名" }, score: { type: "integer", description: "分值，正数加分，负数扣分" }, reason: { type: "string", description: "加减分理由" }, account_id: { type: "string", description: "可选，设置页已选账号的 ID" }, class_id: { type: "string", description: "可选，设置页已选班级的 ID" } } } }, addScore);
  api.registerTool({ name: "list_students", description: "列出当前 SecScore 班级的同学及实时积分。", hidden: true, inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" }, group_name: { type: "string" }, limit: { type: "integer" }, account_id: { type: "string" }, class_id: { type: "string" } } } }, listStudents);
  api.registerTool({ name: "find_students", description: "按姓名搜索当前 SecScore 班级的同学。", hidden: true, inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string" }, account_id: { type: "string" }, class_id: { type: "string" } } } }, async (args) => (await findStudent(args)).matches);
  api.registerTool({ name: "list_groups", description: "列出当前 SecScore 班级的分组及每组人数。", hidden: true, inputSchema: { type: "object", additionalProperties: false, properties: { account_id: { type: "string" }, class_id: { type: "string" } } } }, async (args) => { const result = await listStudents({ ...args, limit: 2000 }); const groups = new Map(); for (const student of result.students) { const name = student.group_name || "未分组"; groups.set(name, (groups.get(name) || 0) + 1); } return [...groups.entries()].map(([name, count]) => ({ name, count })); });
  api.registerTool({ name: "list_group_members", description: "列出当前 SecScore 班级指定分组内的同学。", hidden: true, inputSchema: { type: "object", additionalProperties: false, required: ["group_name"], properties: { group_name: { type: "string" }, account_id: { type: "string" }, class_id: { type: "string" } } } }, async (args) => listStudents({ ...args, limit: 2000 }));
  api.registerSkill(SKILL_PATH, SKILL_AUTO_LOAD_PATTERN);
  api.registerSettingsHandler(PAGE_ID, callAction);
  registered = true;
  let refreshPromise;
  const refreshConnection = async () => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const session = await refreshCurrentSession();
      if (!session?.accessToken || !selected.accountId) {
        api.setStatus("SecScore 工具已加载，等待 SECTL 登录");
        return;
      }
      const classes = await loadClasses(selected.accountId);
      api.setStatus(`SecScore 已连接（${classes.length} 个班级，${registered ? "工具已就绪" : ""}）`);
    })().catch((error) => {
      api.setStatus(`SecScore 已加载但云端未连接：${error instanceof Error ? error.message : String(error)}`, "error");
    }).finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  };
  await refreshConnection();
  const timer = setInterval(() => { void refreshConnection(); }, 30_000);
  timer.unref?.();

  return () => {
    if (!registered) return;
    clearInterval(timer);
    for (const name of ["add_score", "list_students", "find_students", "list_groups", "list_group_members"]) api.unregisterTool(name);
    api.unregisterSkill("secscore");
    api.unregisterSettingsHandler(PAGE_ID);
    registered = false;
  };
}
