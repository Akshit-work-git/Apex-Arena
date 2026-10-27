const ASSETS = {
  html: "__INDEX_HTML__",
  css: "__STYLES_CSS__",
  js: "__APP_JS__",
};

const OPENF1 = "https://api.openf1.org/v1";
const FOOTBALL_LEAGUES = ["eng.1", "esp.1", "ger.1", "ita.1", "fra.1", "uefa.champions", "uefa.europa"];
const arenaLayouts = new Map();

const json = (data, status = 200, maxAge = 20) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=60`,
    "access-control-allow-origin": "*",
  },
});

async function getJSON(url, timeout = 9000) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "ApexArena/1.0" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}`);
  return response.json();
}

function latestByDriver(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const existing = map.get(row.driver_number);
    if (!existing || String(row.date || "") > String(existing.date || "")) map.set(row.driver_number, row);
  }
  return map;
}

async function getF1() {
  const [sessions, drivers, results] = await Promise.all([
    getJSON(`${OPENF1}/sessions?session_key=latest`),
    getJSON(`${OPENF1}/drivers?session_key=latest`),
    getJSON(`${OPENF1}/session_result?session_key=latest`).catch(() => []),
  ]);
  const session = sessions.at(-1) || {};
  const resultMap = new Map(results.map((row) => [row.driver_number, row]));
  const now = Date.now();
  const start = Date.parse(session.date_start || 0);
  const end = Date.parse(session.date_end || 0);
  const live = start <= now && now <= end;
  const positions = results.length ? [] : await getJSON(`${OPENF1}/position?session_key=latest`).catch(() => []);
  const positionMap = latestByDriver(positions);
  const standings = drivers.map((driver) => {
    const result = resultMap.get(driver.driver_number);
    const position = positionMap.get(driver.driver_number);
    return {
      driverNumber: driver.driver_number,
      acronym: driver.name_acronym,
      name: driver.full_name,
      team: driver.team_name,
      teamColour: `#${driver.team_colour || "888888"}`,
      headshot: driver.headshot_url,
      position: result?.position ?? position?.position ?? null,
      gap: result?.gap_to_leader ?? null,
      laps: result?.number_of_laps ?? null,
      points: result?.points ?? 0,
      dnf: Boolean(result?.dnf),
      dns: Boolean(result?.dns),
      dsq: Boolean(result?.dsq),
    };
  }).sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
  return {
    provider: "OpenF1",
    fetchedAt: new Date().toISOString(),
    live,
    session: {
      name: session.session_name || session.session_type || "Latest session",
      circuit: session.circuit_short_name || "—",
      country: session.country_name || "—",
      startTime: session.date_start,
      endTime: session.date_end,
      sessionKey: session.session_key,
    },
    standings,
  };
}

function normalizeEspn(event, leagueCode) {
  const competition = event.competitions?.[0] || {};
  const home = competition.competitors?.find((team) => team.homeAway === "home") || {};
  const away = competition.competitors?.find((team) => team.homeAway === "away") || {};
  return {
    id: String(event.id),
    leagueCode,
    league: event.league?.name || competition.league?.name || leagueCode,
    home: home.team?.displayName || "Home",
    away: away.team?.displayName || "Away",
    homeAbbr: home.team?.abbreviation || "HOM",
    awayAbbr: away.team?.abbreviation || "AWY",
    homeLogo: home.team?.logo || null,
    awayLogo: away.team?.logo || null,
    homeScore: home.score ?? null,
    awayScore: away.score ?? null,
    status: event.status?.type?.state === "in" ? "LIVE" : event.status?.type?.completed ? "FINISHED" : "UPCOMING",
    detail: event.status?.type?.shortDetail || event.status?.type?.detail || "",
    startTime: event.date,
    provider: "ESPN",
  };
}

function usefulStats(stats = []) {
  return stats.filter((stat) => Number(stat.value) > 0).slice(0, 5).map((stat) => ({
    name: stat.shortDisplayName || stat.abbreviation || stat.displayName,
    value: stat.displayValue ?? stat.value,
  }));
}

async function getFootballDetails(id, league) {
  if (!/^\d{6,12}$/.test(id) || !FOOTBALL_LEAGUES.includes(league)) throw new Error("Invalid match identifier");
  const data = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/summary?event=${id}`);
  const competition = data.header?.competitions?.[0] || {};
  const rosters = (data.rosters || []).map((roster) => ({
    team: roster.team?.displayName || roster.team?.name || "Team",
    teamLogo: roster.team?.logo || roster.team?.logos?.[0]?.href || null,
    formation: roster.formation || null,
    homeAway: roster.homeAway,
    players: (roster.roster || []).map((entry) => ({
      id: entry.athlete?.id,
      name: entry.athlete?.displayName || entry.athlete?.fullName || "Unknown player",
      shortName: entry.athlete?.shortName || entry.athlete?.displayName,
      jersey: entry.jersey || "—",
      position: entry.position?.abbreviation || entry.position?.displayName || "—",
      starter: Boolean(entry.starter),
      subbedIn: Boolean(entry.subbedIn),
      subbedOut: Boolean(entry.subbedOut),
      stats: usefulStats(entry.stats),
    })),
  }));
  const events = (data.keyEvents || competition.details || []).filter((event) => {
    const type = String(event.type?.type || event.type?.text || "").toLowerCase();
    return event.scoringPlay || event.redCard || type.includes("goal") || type.includes("card") || type.includes("substitution");
  }).map((event) => ({
    type: event.type?.text || (event.scoringPlay ? "Goal" : event.redCard ? "Red card" : "Match event"),
    minute: event.clock?.displayValue || "",
    team: event.team?.displayName || event.team?.name || "",
    players: (event.participants || []).map((participant) => participant.athlete?.displayName).filter(Boolean),
    scoringPlay: Boolean(event.scoringPlay),
    redCard: Boolean(event.redCard),
  }));
  const teams = (competition.competitors || []).map((entry) => ({
    name: entry.team?.displayName || entry.team?.name,
    abbreviation: entry.team?.abbreviation,
    logo: entry.team?.logos?.[0]?.href || entry.team?.logo || null,
    score: entry.score,
    homeAway: entry.homeAway,
    record: entry.record?.[0]?.summary || null,
  }));
  return {
    provider: "ESPN",
    fetchedAt: new Date().toISOString(),
    id,
    league,
    status: competition.status?.type?.shortDetail || competition.status?.type?.detail || "",
    date: competition.date,
    venue: data.gameInfo?.venue?.fullName || data.gameInfo?.venue?.address?.city || null,
    teams,
    rosters,
    events,
  };
}

function normalizeSportsDb(event) {
  const code = String(event.strStatus || "").toUpperCase();
  const finished = ["FT", "AET", "PEN", "AOT"].includes(code);
  const upcoming = !event.intHomeScore && !event.intAwayScore && ["NS", ""].includes(code);
  return {
    id: String(event.idEvent),
    league: event.strLeague || "Football",
    home: event.strHomeTeam || "Home",
    away: event.strAwayTeam || "Away",
    homeAbbr: String(event.strHomeTeam || "HOM").slice(0, 3).toUpperCase(),
    awayAbbr: String(event.strAwayTeam || "AWY").slice(0, 3).toUpperCase(),
    homeLogo: event.strHomeTeamBadge || null,
    awayLogo: event.strAwayTeamBadge || null,
    homeScore: event.intHomeScore,
    awayScore: event.intAwayScore,
    status: finished ? "FINISHED" : upcoming ? "UPCOMING" : "LIVE",
    detail: event.strStatus || event.strTime || "",
    startTime: `${event.dateEvent || ""}T${event.strTime || "00:00:00"}Z`,
    provider: "TheSportsDB",
  };
}

async function getFootball(date) {
  const compact = date.replaceAll("-", "");
  const attempts = await Promise.allSettled(FOOTBALL_LEAGUES.map(async (league) => {
    const data = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${compact}`);
    return (data.events || []).map((event) => normalizeEspn(event, league));
  }));
  let fixtures = attempts.flatMap((attempt) => attempt.status === "fulfilled" ? attempt.value : []);
  let provider = "ESPN";
  if (!fixtures.length) {
    const data = await getJSON(`https://www.thesportsdb.com/api/v1/json/123/eventsday.php?d=${date}&s=Soccer`);
    fixtures = (data.events || []).map(normalizeSportsDb);
    provider = "TheSportsDB";
  }
  const unique = [...new Map(fixtures.map((fixture) => [fixture.id, fixture])).values()]
    .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  return { provider, date, fetchedAt: new Date().toISOString(), fixtures: unique };
}

function scoreTrendFromCompetitor(competitor) {
  const lines = competitor?.linescores || [];
  let total = 0;
  return lines.map((line) => total += Number(line.value ?? line.displayValue ?? 0));
}

function normalizeArenaEspn(event, sport, leagueCode) {
  const competition = event.competitions?.[0] || {};
  const home = competition.competitors?.find((team) => team.homeAway === "home") || {};
  const away = competition.competitors?.find((team) => team.homeAway === "away") || {};
  const state = event.status?.type?.state;
  const status = state === "in" ? "LIVE" : event.status?.type?.completed ? "FINISHED" : "UPCOMING";
  const period = event.status?.period || competition.status?.period || 0;
  const clock = event.status?.displayClock || competition.status?.displayClock || event.status?.type?.shortDetail || "—";
  const homeTrend = scoreTrendFromCompetitor(home);
  const awayTrend = scoreTrendFromCompetitor(away);
  const sportMetrics = sport === "NBA" ? {
    quarter: period || 1,
    gameClock: clock,
    shotClock: null,
    fouls: { home: null, away: null },
    timeouts: { home: null, away: null },
    trend: (homeTrend.length ? homeTrend : [Number(home.score || 0)]),
  } : {
    period: period || 1,
    clock,
    powerPlay: { team: "—", clock: "—" },
    shots: { home: null, away: null },
    penalties: { home: null, away: null },
    trend: (homeTrend.length ? homeTrend : [Number(home.score || 0)]),
  };
  return {
    id: `${sport.toLowerCase()}-${event.id}`,
    providerId: String(event.id),
    provider: "ESPN",
    sport,
    leagueCode,
    title: `${home.team?.displayName || "Home"} vs ${away.team?.displayName || "Away"}`,
    home: home.team?.abbreviation || home.team?.shortDisplayName || "HOME",
    away: away.team?.abbreviation || away.team?.shortDisplayName || "AWAY",
    homeName: home.team?.displayName || "Home",
    awayName: away.team?.displayName || "Away",
    homeLogo: home.team?.logo || null,
    awayLogo: away.team?.logo || null,
    hs: home.score ?? "—",
    as: away.score ?? "—",
    status,
    meta: event.status?.type?.shortDetail || clock,
    startTime: event.date,
    updatedAt: new Date().toISOString(),
    sportMetrics,
  };
}

function normalizeArenaSportsDb(event, sport) {
  const code = String(event.strStatus || "").toUpperCase();
  const status = ["FT", "AET", "PEN", "AOT"].includes(code) ? "FINISHED" : ["NS", ""].includes(code) ? "UPCOMING" : "LIVE";
  const common = {
    id: `${sport.toLowerCase()}-${event.idEvent}`,
    providerId: String(event.idEvent),
    provider: "TheSportsDB",
    sport,
    leagueCode: event.idLeague || event.strLeague,
    title: `${event.strHomeTeam || "Home"} vs ${event.strAwayTeam || "Away"}`,
    home: String(event.strHomeTeam || "HOME").slice(0, 3).toUpperCase(),
    away: String(event.strAwayTeam || "AWAY").slice(0, 3).toUpperCase(),
    homeName: event.strHomeTeam || "Home",
    awayName: event.strAwayTeam || "Away",
    homeLogo: event.strHomeTeamBadge || null,
    awayLogo: event.strAwayTeamBadge || null,
    hs: event.intHomeScore ?? "—",
    as: event.intAwayScore ?? "—",
    status,
    meta: event.strStatus || event.strTime || "SCHEDULED",
    startTime: `${event.dateEvent || ""}T${event.strTime || "00:00:00"}Z`,
    updatedAt: new Date().toISOString(),
  };
  if (sport === "CRICKET") common.sportMetrics = { innings: event.strStatus || "—", overs: "—", crr: "—", requiredRate: "—", batters: [], bowler: "Provider update pending", lastSix: [], trend: [Number(event.intHomeScore || 0)] };
  if (sport === "VOLLEYBALL") common.sportMetrics = { currentSet: "—", setScores: [], serving: "—", timeouts: { home: null, away: null }, trend: [Number(event.intHomeScore || 0)] };
  return common;
}

async function getArenaEvents(date) {
  const compact = date.replaceAll("-", "");
  const [nba, nhl, football, cricket, volleyball, f1] = await Promise.allSettled([
    getJSON(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${compact}`),
    getJSON(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=${compact}`),
    getFootball(date),
    getJSON(`https://www.thesportsdb.com/api/v1/json/123/eventsday.php?d=${date}&s=Cricket`),
    getJSON(`https://www.thesportsdb.com/api/v1/json/123/eventsday.php?d=${date}&s=Volleyball`),
    getF1(),
  ]);
  const events = [];
  if (nba.status === "fulfilled") events.push(...(nba.value.events || []).map((event) => normalizeArenaEspn(event, "NBA", "nba")));
  if (nhl.status === "fulfilled") events.push(...(nhl.value.events || []).map((event) => normalizeArenaEspn(event, "NHL", "nhl")));
  if (football.status === "fulfilled") events.push(...football.value.fixtures.map((event) => ({ ...event, id: `soccer-${event.id}`, sport: "SOCCER", title: `${event.home} vs ${event.away}`, hs: event.homeScore ?? "—", as: event.awayScore ?? "—", meta: event.detail || event.status, updatedAt: football.value.fetchedAt, sportMetrics: { minute: event.detail || "—", shotsOnTarget: { home: null, away: null }, cards: { home: { yellow: null, red: null }, away: { yellow: null, red: null } }, possession: { home: null, away: null }, trend: [Number(event.homeScore || 0)] } })));
  if (cricket.status === "fulfilled") events.push(...(cricket.value.events || []).map((event) => normalizeArenaSportsDb(event, "CRICKET")));
  if (volleyball.status === "fulfilled") events.push(...(volleyball.value.events || []).map((event) => normalizeArenaSportsDb(event, "VOLLEYBALL")));
  if (f1.status === "fulfilled") {
    const top = f1.value.standings.slice(0, 5);
    events.unshift({ id: "f1-latest", provider: "OpenF1", sport: "F1", title: `${f1.value.session.circuit} · ${f1.value.session.name}`, home: top[0]?.acronym || "P1", away: top[1]?.acronym || "P2", hs: 1, as: 2, status: f1.value.live ? "LIVE" : "FINISHED", meta: f1.value.live ? "LIVE SESSION" : "LATEST COMPLETE", startTime: f1.value.session.startTime, updatedAt: f1.value.fetchedAt, standings: top });
  }
  return {
    date,
    fetchedAt: new Date().toISOString(),
    events,
    providers: {
      openF1: f1.status === "fulfilled",
      football: football.status === "fulfilled",
      nba: nba.status === "fulfilled",
      nhl: nhl.status === "fulfilled",
      cricket: cricket.status === "fulfilled",
      volleyball: volleyball.status === "fulfilled",
    },
  };
}

async function api(request, url) {
  try {
    if (url.pathname === "/api/f1/standings") return json(await getF1(), 200, 30);
    if (url.pathname === "/api/football") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Invalid date" }, 400, 0);
      return json(await getFootball(date), 200, 30);
    }
    if (url.pathname === "/api/football/details") {
      const id = url.searchParams.get("id") || "";
      const league = url.searchParams.get("league") || "";
      return json(await getFootballDetails(id, league), 200, 60);
    }
    if (url.pathname === "/api/events") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Invalid date" }, 400, 0);
      return json(await getArenaEvents(date), 200, 30);
    }
    if (url.pathname === "/api/arena/layouts") {
      const clientId = (url.searchParams.get("clientId") || "anonymous").slice(0, 80);
      if (request.method === "GET") return json({ layout: arenaLayouts.get(clientId) || null }, 200, 0);
      if (request.method === "POST") {
        const body = await request.json();
        const pinned = Array.isArray(body.pinned) ? body.pinned.filter((id) => typeof id === "string").slice(0, 4) : [];
        const layout = ["2x2", "1x2", "focus"].includes(body.layout) ? body.layout : "2x2";
        const saved = { pinned, layout, updatedAt: new Date().toISOString() };
        arenaLayouts.set(clientId, saved);
        return json({ ok: true, layout: saved }, 200, 0);
      }
      return json({ error: "Method not allowed" }, 405, 0);
    }
    if (url.pathname === "/api/health") return json({
      ok: true,
      service: "apex-arena-aggregator",
      runtime: "cloudflare-worker",
      providers: { f1: "OpenF1", football: "ESPN with TheSportsDB fallback" },
      now: new Date().toISOString(),
    }, 200, 5);
    return json({ error: "API route not found" }, 404, 0);
  } catch (error) {
    return json({ error: "Provider temporarily unavailable", detail: String(error?.message || error), fetchedAt: new Date().toISOString() }, 502, 5);
  }
}

export default {
  async fetch(request, env, ctx) {
    void env;
    void ctx;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, url);
    if (url.pathname === "/styles.css") return new Response(ASSETS.css, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" } });
    if (url.pathname === "/app.js") return new Response(ASSETS.js, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });
    if (url.pathname === "/" || url.pathname === "/index.html") return new Response(ASSETS.html, { headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "content-security-policy": "default-src 'self' data: https:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'",
    } });
    return new Response("Not found", { status: 404 });
  },
};
