import type { TiboSnapshot } from "./env";

export const EMPTY_TIBO: TiboSnapshot = { data: null, fetchedAt: null, error: null };

function time(value: string | number) {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function describeTibo(snapshot: TiboSnapshot, now: number) {
  const scheduled = snapshot.data?.scheduled_reset;
  const watch = snapshot.data?.active_watch;
  if (scheduled) {
    const overdue = scheduled.scheduled_for !== null && Date.parse(scheduled.scheduled_for) <= now;
    return {
      status: overdue ? "等待执行确认" : "已宣布待重置",
      detail: scheduled.scheduled_for ? `重置预计 ${time(scheduled.scheduled_for)}` : "重置时间待定",
    };
  }
  if (watch) {
    const expired = Date.parse(watch.expires_at) <= now;
    return {
      status: expired ? "预测已过期" : watch.reset_chance_percent !== null ? `重置概率 ${watch.reset_chance_percent}%` : watch.level === "strong" ? "重置信号较强" : "重置信号升高",
      detail: `${expired ? "到期时间" : "有效至"} ${time(watch.expires_at)}`,
    };
  }
  return { status: snapshot.data ? "暂无重置信号" : snapshot.error ? "暂时无法查询" : "正在查询…", detail: "" };
}

export default function TiboPrediction({ snapshot, now }: { snapshot: TiboSnapshot; now: number }) {
  const prediction = describeTibo(snapshot, now);
  const last = snapshot.data?.latest_reset;
  // A suspended machine can wake with an old result before its next poll completes.
  const stale = snapshot.fetchedAt !== null && now - snapshot.fetchedAt > 31 * 60 * 1000;
  return <section className="tibo-prediction" aria-label="Tibo Reset 预测">
    <div className="tibo-title">Tibo Reset 预测</div>
    <strong className="tibo-status">{prediction.status}</strong>
    {prediction.detail && <div className="tibo-detail">{prediction.detail}</div>}
    {last && <div className="tibo-detail">最近{last.reset_type === "banked" ? "发放储备次数" : "重置"} {time(last.announced_at)}</div>}
    {(snapshot.error || stale) && <div className="tibo-error">{snapshot.data ? snapshot.error ? "查询失败，显示上次结果" : "结果待更新" : "查询失败，稍后自动重试"}</div>}
  </section>;
}
