import { useEffect, useState } from "react";

type Account = { id: string; name: string; email?: string; source?: string };
type ClassInfo = { id: string; name: string; status?: string };
type State = { serverUrl: string; accounts: Account[]; selectedAccountId: string; selectedClassId: string; classes: ClassInfo[]; hasCurrentSession: boolean };

export function SecScoreSettingsPage({ pluginId, pageId }: { pluginId: string; pageId: string }) {
  const bridge = window.secagent;
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const call = async (action: string, args: Record<string, unknown> = {}) => {
    setBusy(action);
    setError("");
    try {
      const result = await bridge.callPluginSettings(pluginId, pageId, action, args);
      if (result?.accounts || result?.serverUrl || result?.selectedAccountId !== undefined) setState((current) => ({ ...(current || { serverUrl: "", accounts: [], selectedAccountId: "", selectedClassId: "", classes: [], hasCurrentSession: false }), ...result }));
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    } finally {
      setBusy("");
    }
  };

  useEffect(() => { void call("get_state"); }, []);

  const selectAccount = async (accountId: string) => {
    const result = await call("select_account", { account_id: accountId });
    if (result) setState((current) => current && { ...current, ...result });
  };
  const selectClass = async (classId: string) => {
    const result = await call("select_class", { class_id: classId });
    if (result) setState((current) => current && { ...current, ...result });
  };
  const oauthLogin = async () => {
    const result = await call("oauth_login");
    if (result) setState((current) => current && { ...current, ...result, accounts: [...(current.accounts || []), ...(result.account ? [result.account] : [])] });
  };

  if (!state) return <article className="settings-card"><p>正在读取 SecScore 账号状态…</p></article>;
  return <>
    {error && <div className="settings-error">{error}</div>}
    <article className="settings-card">
      <div className="card-heading"><div><strong>云端连接</strong><span>直接使用 SecScore Sync Server，不保存本地业务数据。</span></div><button className="secondary-button" type="button" onClick={() => void call("refresh")} disabled={Boolean(busy)}>刷新</button></div>
      <p className="settings-help">服务器：{state.serverUrl}</p>
    </article>
    <article className="settings-card">
      <div className="card-heading"><div><strong>SecScore 账号</strong><span>默认账号来自 SecAgent 当前 SECTL OAuth 登录态。</span></div><button className="primary-button" type="button" onClick={() => void oauthLogin()} disabled={Boolean(busy)}>通过 OAuth 登录其它账号</button></div>
      <div className="form-grid">
        <label>当前账号<select value={state.selectedAccountId} onChange={(event) => void selectAccount(event.target.value)} disabled={Boolean(busy)}><option value="">请选择账号</option>{state.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.email ? `（${account.email}）` : ""}</option>)}</select></label>
        <label>当前班级<select value={state.selectedClassId} onChange={(event) => void selectClass(event.target.value)} disabled={Boolean(busy) || !state.selectedAccountId}><option value="">请选择班级</option>{state.classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      </div>
      {!state.accounts.length && <p className="settings-help">当前没有可用的 SECTL session。请先登录 SecAgent 官方服务，或点击 OAuth 登录。</p>}
      {state.selectedAccountId && !state.classes.length && <p className="settings-help">该账号暂未加入任何班级。</p>}
    </article>
    <article className="settings-card">
      <div className="card-heading"><strong>Agent 可用能力</strong></div>
      <p className="settings-help">基本积分操作会出现在 Agent 工具列表中；同学列表、搜索、分组和组员查询属于隐藏辅助工具，不会占用 Agent 的默认工具上下文。</p>
    </article>
  </>;
}
