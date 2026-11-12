import { useStore, useT } from "../store";

const DAY = 24 * 60 * 60 * 1000;

// Warns when the SeekingAlpha login has expired (last scrape got no logged-in
// data) or when data has gone stale for several days. Tells you exactly what
// to run — so you never have to watch logs.
export function Banner() {
  const health = useStore((s) => s.health);
  const t = useT();
  if (!health) return null;

  const successAge = health.last_success ? Date.now() - new Date(health.last_success).getTime() : null;

  // Cookie expired: a run happened but returned no logged-in widgets.
  if (health.auth_ok === false) {
    return (
      <Strip tone="bad">
        <b>{t("SeekingAlpha login expired", "SeekingAlpha 登录已过期")}</b>{" "}
        {t("— the last scrape got no logged-in data. Refresh the cookie:", "—— 最近一次抓取没拿到登录后的数据，请更新 cookie：")}
        <Steps />
      </Strip>
    );
  }

  // Data going stale (Mac was off, or scrapes failing for another reason).
  if (successAge != null && successAge > 2.5 * DAY) {
    const days = Math.floor(successAge / DAY);
    return (
      <Strip tone="warn">
        {t("Data hasn't updated in ", "数据已 ")}
        <b>{t(`${days} days`, `${days} 天`)}</b>
        {t(" (Mac was off, or scrapes failing). If it persists, refresh the cookie:", "未更新（Mac 关机、或抓取失败）。若持续，尝试更新 cookie：")}
        <Steps />
      </Strip>
    );
  }

  return null;
}

function Steps() {
  const t = useT();
  return (
    <span className="ml-1 text-current/80">
      {t("Export via Cookie-Editor, then run ", "浏览器 Cookie-Editor 导出后运行 ")}
      <code className="rounded bg-black/25 px-1.5 py-0.5 font-mono text-[12px]">
        bash newsagg/deploy/refresh_cookies.sh
      </code>
    </span>
  );
}

function Strip({ tone, children }: { tone: "bad" | "warn"; children: React.ReactNode }) {
  const cls =
    tone === "bad"
      ? "border-bad/40 bg-bad/15 text-bad"
      : "border-warn/40 bg-warn/15 text-warn";
  return (
    <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-[13px] ${cls}`}>
      <span className="text-base">⚠</span>
      <span className="text-text">{children}</span>
    </div>
  );
}
