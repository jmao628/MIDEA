import { useEffect } from "react";
import { useStore } from "../store";
import type { CatalystData, ConvictionData, HeatData, Health, LedgerData, MarketCaps, PriceTrack, SAData, TechnicalData, SectorData, SupplyChainData } from "../types";

// The scraped snapshot. Served same-origin by the local http.server (built) or
// proxied by Vite in dev. Data updates daily today; polling is the pragmatic
// "realtime" until a streaming source (Schwab/X) is wired to a WS/SSE endpoint.
const DATA_URL = "/data/newsagg/seekingalpha_latest.json";
const HEAT_URL = "/data/newsagg/heat_latest.json";
const TECH_URL = "/data/newsagg/technical_latest.json";
const SECTOR_URL = "/data/newsagg/sectors.json";
const SUPPLY_URL = "/data/newsagg/supplychain.json";
const CATALYST_URL = "/data/newsagg/catalyst.json";
const CATALYST_DATA_URL = "/data/newsagg/catalyst_data.json";
const CONVICTION_URL = "/data/newsagg/conviction.json";
const TRACK_URL = "/data/newsagg/price_track.json";
const HISTORY_URL = "/data/newsagg/price_history.json";
const LEDGER_URL = "/data/newsagg/ledger.json";
const MCAP_URL = "/data/newsagg/marketcaps.json";
const HEALTH_URL = "/data/newsagg/health.json";
const POLL_MS = 15_000;

// Prices drive every ranking, so THEY decide the status light. Stale = no
// technical run since the last completed trading session should have produced
// one. Weekend-aware: Friday's run is current all weekend and until Monday's
// close; on Tue–Fri anything older than ~1.5 days is stale.
export function pricesStale(generatedAt: string | undefined | null, now: Date = new Date()): boolean {
  if (!generatedAt) return false;
  const age = now.getTime() - new Date(generatedAt).getTime();
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
  const grace = wd === "Sat" || wd === "Sun" || wd === "Mon" ? 84 : 36; // hours
  return age > grace * 60 * 60 * 1000;
}

export function usePoller() {
  const setData = useStore((s) => s.setData);
  const setHeat = useStore((s) => s.setHeat);
  const setTechnical = useStore((s) => s.setTechnical);
  const setSectors = useStore((s) => s.setSectors);
  const setSupplychain = useStore((s) => s.setSupplychain);
  const setCatalyst = useStore((s) => s.setCatalyst);
  const setCatalystData = useStore((s) => s.setCatalystData);
  const setConviction = useStore((s) => s.setConviction);
  const setTrack = useStore((s) => s.setTrack);
  const setHistory = useStore((s) => s.setHistory);
  const setLedger = useStore((s) => s.setLedger);
  const setMarketCaps = useStore((s) => s.setMarketCaps);
  const setHealth = useStore((s) => s.setHealth);
  const setStatus = useStore((s) => s.setStatus);

  useEffect(() => {
    let alive = true;

    async function tick() {
      try {
        const res = await fetch(`${DATA_URL}?t=${Date.now()}`);
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as SAData;
        if (!alive) return;
        setData(json);
        // The seed scrape's age is NOT a staleness signal: it runs on a 30-day
        // carryover and isn't part of the daily refresh. Prices decide (below).
      } catch {
        if (alive) setStatus("error");
      }
      // Heat / market caps / health are best-effort; absent = no data yet.
      try {
        const hres = await fetch(`${HEAT_URL}?t=${Date.now()}`);
        if (alive) setHeat(hres.ok ? ((await hres.json()) as HeatData) : null);
      } catch {
        /* ignore */
      }
      try {
        const tres = await fetch(`${TECH_URL}?t=${Date.now()}`);
        if (tres.ok) {
          const tjson = (await tres.json()) as TechnicalData;
          if (alive) {
            setTechnical(tjson);
            // The leaderboard ranks by today's move — which lives in THIS file,
            // not the SA snapshot. If prices haven't refreshed since the last
            // session (weekend-aware), flag it, or the LIVE badge misleads while
            // rankings sit frozen.
            if (pricesStale(tjson.generated_at)) setStatus("stale");
          }
        } else if (alive) setTechnical(null);
      } catch {
        /* ignore */
      }
      try {
        const sres = await fetch(`${SECTOR_URL}?t=${Date.now()}`);
        if (alive) setSectors(sres.ok ? ((await sres.json()) as SectorData) : null);
      } catch {
        /* ignore */
      }
      try {
        const scres = await fetch(`${SUPPLY_URL}?t=${Date.now()}`);
        if (alive) setSupplychain(scres.ok ? ((await scres.json()) as SupplyChainData) : null);
      } catch {
        /* ignore */
      }
      try {
        const cres = await fetch(`${CATALYST_URL}?t=${Date.now()}`);
        if (alive) setCatalyst(cres.ok ? ((await cres.json()) as CatalystData) : null);
      } catch {
        /* ignore */
      }
      try {
        const cdres = await fetch(`${CATALYST_DATA_URL}?t=${Date.now()}`);
        if (alive) setCatalystData(cdres.ok ? ((await cdres.json()) as CatalystData) : null);
      } catch {
        /* ignore */
      }
      try {
        const cvres = await fetch(`${CONVICTION_URL}?t=${Date.now()}`);
        if (alive) setConviction(cvres.ok ? ((await cvres.json()) as ConvictionData) : null);
      } catch {
        /* ignore */
      }
      try {
        const trres = await fetch(`${TRACK_URL}?t=${Date.now()}`);
        if (alive) setTrack(trres.ok ? ((await trres.json()) as PriceTrack) : null);
      } catch {
        /* ignore */
      }
      try {
        const phres = await fetch(`${HISTORY_URL}?t=${Date.now()}`);
        if (alive) setHistory(phres.ok ? ((await phres.json()) as PriceTrack) : null);
      } catch {
        /* ignore */
      }
      try {
        const lres = await fetch(`${LEDGER_URL}?t=${Date.now()}`);
        if (alive) setLedger(lres.ok ? ((await lres.json()) as LedgerData) : null);
      } catch {
        /* ignore */
      }
      try {
        const mres = await fetch(`${MCAP_URL}?t=${Date.now()}`);
        if (alive) setMarketCaps(mres.ok ? ((await mres.json()) as MarketCaps) : null);
      } catch {
        /* ignore */
      }
      try {
        const hres = await fetch(`${HEALTH_URL}?t=${Date.now()}`);
        if (alive) setHealth(hres.ok ? ((await hres.json()) as Health) : null);
      } catch {
        /* ignore */
      }
    }

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [setData, setHeat, setTechnical, setSectors, setSupplychain, setCatalyst, setCatalystData, setConviction, setTrack, setHistory, setLedger, setMarketCaps, setHealth, setStatus]);
}
