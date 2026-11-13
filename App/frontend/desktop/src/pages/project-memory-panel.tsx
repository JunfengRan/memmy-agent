import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectMemoryTopic, ProjectMemoryView } from "@memmy/local-api-contracts";
import { createProjectMemoryClient } from "../api/project-memory-client.js";
import { useApiClients } from "../app/providers.js";
import { useTranslation } from "../i18n/use-translation.js";
import { Modal } from "../components/modal.js";
import styles from "./project-memory-panel.module.css";

function useMemory(projectId: string) {
  const { clients } = useApiClients();
  return useMemo(() => clients ? createProjectMemoryClient(clients.runtimeConfig, projectId) : null, [clients, projectId]);
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function ProjectMemorySetting({ projectId }: { projectId: string }) {
  const client = useMemory(projectId);
  const { language } = useTranslation();
  const en = language.startsWith("en");
  const [view, setView] = useState<ProjectMemoryView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { let current = true; setView(null); if (client) void client.view().then(value => { if (current) setView(value); }).catch(error => { if (current) setError(errorText(error)); }); return () => { current = false; }; }, [client]);
  return <section className={styles.setting}>
    <div><h3>{en ? "Local project memory" : "本机项目记忆"}</h3><p>{en ? "Remember new turns in this project. Import previous tasks separately. Stored on this computer." : "开启后整理本项目的新对话，历史任务可手动导入。记忆保存在本机。"}</p></div>
    <input type="checkbox" role="switch" aria-label={en ? "Enable local project memory" : "启用本机项目记忆"} checked={view?.binding?.enabled ?? false} disabled={!view || busy} onChange={event => {
      const enabled = event.target.checked;
      setBusy(true); setError("");
      void client?.configure(enabled).then(setView).catch(error => setError(errorText(error))).finally(() => setBusy(false));
    }} />
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

export function ProjectMemoryPanel(props: { projectId: string; projectName: string; onClose: () => void; onOpenSource: (key: string) => void; sourceKeys: readonly string[] }) {
  const client = useMemory(props.projectId);
  const { language } = useTranslation();
  const en = language.startsWith("en");
  const [view, setView] = useState<ProjectMemoryView | null>(null);
  const [topics, setTopics] = useState<ProjectMemoryTopic[]>([]);
  const [detail, setDetail] = useState<ProjectMemoryTopic | null>(null);
  const [sessions, setSessions] = useState<Array<{ conversationId: string; title: string; turnCount: number }>>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refreshEpoch = useRef(0);
  const refresh = useCallback(async () => {
    if (!client) return;
    const epoch = ++refreshEpoch.current;
    const next = await client.view();
    const result = next.binding ? await client.topics(page) : { topic_detail_list: [], total: 0 };
    if (epoch !== refreshEpoch.current) return;
    setView(next); setTopics(result.topic_detail_list); setTotal(result.total); setError("");
  }, [client, page]);
  useEffect(() => { let current = true; let running = false; const run = async () => { if (running) return; running = true; try { if (current) await refresh(); } catch (error) { if (current) setError(errorText(error)); } finally { running = false; } }; void run(); const timer = setInterval(() => void run(), 3000); return () => { current = false; clearInterval(timer); }; }, [refresh]);
  async function action(run: () => Promise<unknown>) { setBusy(true); setError(""); try { await run(); await refresh(); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } }
  const statuses = { pending: en ? "Queued" : "待提交", running: en ? "Organizing" : "整理中", completed: en ? "Completed" : "已完成", failed: en ? "Failed" : "失败" };
  function entries(title: string, values: ProjectMemoryTopic["decisions"]) {
    return values.length ? <section><h3>{title}</h3>{values.map((entry, index) => <div className={styles.entry} key={entry.id ?? index}>
      <p>{entry.content}</p><small title={entry.user_ids.join("、")}>{new Date(entry.time).toLocaleString(en ? "en-US" : "zh-CN")}</small>
      {entry.conflicts.length ? <div><b>{en ? "Conflicts" : "未决分歧"}</b>{entry.conflicts.map((item, i) => <p key={i}>{item.content} <small>{item.time}</small></p>)}</div> : null}
      {entry.history.length ? <details><summary>{en ? "History" : "历次结论"}</summary>{entry.history.map((item, i) => <p key={i}>{item.content} <small>{item.time}</small>{typeof item.reason === "string" ? ` · ${item.reason}` : ""}</p>)}</details> : null}
    </div>)}</section> : null;
  }
  return <Modal open title={`${en ? "Project memory" : "项目记忆"} · ${props.projectName}`} onClose={props.onClose} closeLabel={en ? "Close" : "关闭"} className={styles.modal}>
    <div className={styles.body}>
      {error || view?.error ? <p role="alert">{error || view?.error}</p> : null}
      {!view ? <p role="status">{en ? "Loading…" : "正在读取…"}</p> : <>
        <div className={styles.toolbar}>
          <span>{view.binding?.enabled ? (en ? "Enabled on this computer" : "本机已开启") : (en ? "Not enabled" : "尚未开启")}</span>
          <button disabled={busy || !client} onClick={() => void action(async () => { await client!.configure(!view.binding?.enabled); })}>{view.binding?.enabled ? (en ? "Disable" : "关闭") : (en ? "Enable" : "开启")}</button>
          <button disabled={busy || !view.binding?.enabled} onClick={() => void action(async () => { const result = await client!.sessions(); setSessions(result.sessions); setImportOpen(true); })}>{en ? "Import previous tasks" : "导入历史任务"}</button>
          <button disabled={busy} onClick={() => void action(refresh)}>{en ? "Refresh" : "刷新"}</button>
        </div>
        <p className={styles.hint}>{en ? "Memory stays on this computer. Disabling stops new collection and recall and keeps existing memory." : "记忆仅保存在本机。关闭后停止新内容整理和召回，已有记忆保留。"}</p>
        {importOpen ? <section className={styles.import}><h3>{en ? "Choose local Memmy tasks" : "选择本项目的本机 Memmy 任务"}</h3>
          {!sessions.length ? <p>{en ? "No completed tasks." : "暂无已完成轮次的任务。"}</p> : sessions.map(session => <label key={session.conversationId}><input type="checkbox" checked={selected.includes(session.conversationId)} onChange={event => setSelected(old => event.target.checked ? [...old, session.conversationId] : old.filter(key => key !== session.conversationId))} />{session.title} · {session.turnCount}</label>)}
          <button disabled={!selected.length || busy} onClick={() => void action(async () => { await client!.importSessions(selected); setImportOpen(false); setSelected([]); })}>{en ? "Import selected" : "导入所选任务"}</button>
          <button onClick={() => setImportOpen(false)}>{en ? "Cancel" : "取消"}</button>
        </section> : null}
        {view.jobs.length ? <details><summary>{en ? "Organization tasks" : "整理任务"} · {view.jobs.filter(job => job.status === "completed").length}/{view.jobs.length}</summary>
          {view.jobs.map(job => <div className={styles.job} key={job.id}><span>{job.title} · {statuses[job.status]}</span>{job.error ? <p role="alert">{job.error}</p> : null}</div>)}
          {view.jobs.some(job => job.status === "failed") ? <button disabled={busy} onClick={() => void action(async () => { await client!.retry(); })}>{en ? "Retry failed tasks" : "重试失败任务"}</button> : null}
        </details> : null}
        <div className={styles.columns}>
          <section><h3>{en ? "Topics" : "主题"} · {total}</h3>
            {!topics.length ? <p>{en ? "No memory yet. Finish a conversation or import previous tasks." : "暂无记忆。开启后完成一轮对话，或导入历史任务。"}</p> : topics.map(topic => <button className={styles.topic} aria-pressed={detail?.id === topic.id} key={topic.id} onClick={() => void action(async () => { const result = await client!.topic(topic.id); setDetail(result.topic_detail_list[0] ?? null); })}><b>{topic.topic_name}</b><span>{topic.topic_summary}</span></button>)}
            <div className={styles.toolbar}><button disabled={page === 1} onClick={() => setPage(page - 1)}>{en ? "Previous" : "上一页"}</button><span>{page}</span><button disabled={page * 20 >= total} onClick={() => setPage(page + 1)}>{en ? "Next" : "下一页"}</button></div>
          </section>
          {detail ? <article><h2>{detail.topic_name}</h2><p>{detail.topic_description}</p>
            {entries(en ? "Decisions" : "决策", detail.decisions)}{entries(en ? "Experience" : "经验", detail.experiences)}
            {detail.timeline.length ? <section><h3>{en ? "Timeline" : "演变轨迹"}</h3>{detail.timeline.map((entry, i) => <p key={i}>{entry.content} <small>{entry.time}</small></p>)}</section> : null}
            <h3>{en ? "Source tasks" : "来源任务"}</h3>{detail.sources.map((source, i) => <button key={i} disabled={!source.conversation_id || !props.sourceKeys.includes(source.conversation_id)} onClick={() => { if (source.conversation_id) props.onOpenSource(source.conversation_id); }}>{source.conversation_id ? (en ? "Open source task" : "查看来源任务") : (en ? "Unavailable" : "来源不可用")}</button>)}
          </article> : <p className={styles.hint}>{en ? "Select a topic to see its decisions and history." : "选择主题查看决策与来龙去脉。"}</p>}
        </div>
      </>}
    </div>
  </Modal>;
}
