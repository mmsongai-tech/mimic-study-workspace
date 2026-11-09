const labels = { ready: "可用", degraded: "降级", disabled: "已停用", unknown: "待首次验证" };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const parameters = new URLSearchParams(window.location.search);
const requestedReturn = parameters.get("return_to");
const returnTo = requestedReturn?.startsWith("/") && !requestedReturn.startsWith("//") ? requestedReturn : "/";
document.querySelector("#workspace-return-link").href = returnTo;
document.querySelector("#audit-link").href = `/developer/audit?return_to=${encodeURIComponent(returnTo)}`;
const render = async () => {
  const summary = document.querySelector("#summary");
  const container = document.querySelector("#capabilities");
  try {
    const response = await fetch("/health/ready", { cache: "no-store" });
    const report = await response.json();
    summary.className = `summary ${report.status}`;
    summary.innerHTML = `<b>${report.status === "ready" ? "核心服务可用" : "本地工作台可用，部分能力降级"}</b><span>${report.status === "ready" ? "当前没有阻断性故障。" : "降级能力不会阻止本页面和研究工作台打开。"}</span>`;
    container.innerHTML = report.capabilities.map((item) => `<article><div class="capability-head"><h3>${escapeHtml(item.label)}</h3><span class="state ${escapeHtml(item.state)}">${escapeHtml(labels[item.state] ?? item.state)}</span></div><p>${escapeHtml(item.summary)}</p>${item.failure_stage ? `<dl><dt>失败阶段</dt><dd><code>${escapeHtml(item.failure_stage)}</code></dd></dl>` : ""}${item.reason ? `<dl><dt>具体原因</dt><dd>${escapeHtml(item.reason)}</dd></dl>` : ""}${item.next_action ? `<dl><dt>建议动作</dt><dd>${escapeHtml(item.next_action)}</dd></dl>` : ""}<small>检查时间：${escapeHtml(item.checked_at)}</small></article>`).join("");
  } catch {
    summary.className = "summary offline";
    summary.innerHTML = "<b>无法读取本地服务状态</b><span>Node 服务可能未启动、端口被占用或进程已经退出。</span>";
    container.innerHTML = "";
  }
};
document.querySelector("#refresh").addEventListener("click", render); render();
