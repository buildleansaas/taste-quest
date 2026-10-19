export type EntityType = "artist" | "movie" | "tv_show" | "place";
export type TagCat = "cuisine" | "vibe";
export type Pace = "easy" | "brisk" | "stepfree";
export type BudgetMode = "1h" | "2h" | "tonight" | "allday";
export type StopState = "todo" | "next" | "visited" | "skipped" | "vetoed";
export type WalkStatus = "planning" | "active" | "done" | "abandoned";
export type RerouteReason =
  | "initial"
  | "offroute"
  | "skip"
  | "veto"
  | "late"
  | "closed"
  | "weather";

export type TasteEntity = {
  id: string;
  name: string;
  type: EntityType;
  weight?: number;
  subtitle?: string;
};

export type TasteTag = {
  id: string;
  name: string;
  cat: TagCat;
  weight?: number;
};

export type TasteProfile = {
  entities: TasteEntity[];
  tags: TasteTag[];
  updatedAt: string;
};

export type Budget = {
  minutes: number;
  mode: BudgetMode;
  pace: Pace;
};

export type StartPoint = {
  lat: number;
  lon: number;
  label?: string;
  source: "gps" | "pin" | "demo";
  accuracyM?: number;
};

export type LatLon = { lat: number; lon: number };

export type PlaceTag = { id: string; name: string; type?: string };

export type HoursInterval = { opens: string; closes: string };
export type PlaceHours = Record<string, HoursInterval[]>;

export type EntityShare = { entityId: string; name: string; share: number };

export type Candidate = {
  entityId: string;
  name: string;
  lat: number;
  lon: number;
  affinity: number;
  address?: string;
  shortDescription?: string;
  category: string;
  categoryLabel: string;
  tags: PlaceTag[];
  hours?: PlaceHours;
  isClosed?: boolean;
  neighborhood?: string;
  imageUrl?: string;
  priceLevel?: number;
  entityShares: EntityShare[];
  sample?: boolean;
};

export type Evidence = {
  entityShares: EntityShare[];
  tagOverlap: { id: string; name: string }[];
};

export type Stop = {
  seq: number;
  entityId: string;
  name: string;
  lat: number;
  lon: number;
  affinity: number;
  affinityRank: number;
  etaMin: number;
  walkMin: number;
  dwellMin: number;
  state: StopState;
  category: string;
  categoryLabel: string;
  address?: string;
  neighborhood?: string;
  evidence: Evidence;
  blurb?: string;
  hours?: PlaceHours;
  imageUrl?: string;
  closingSoon?: boolean;
  closedNow?: boolean;
  sample?: boolean;
  /** Just inserted by a re-route. Draws the flare "New" pin. */
  introduced?: boolean;
};

export type LineString = {
  type: "LineString";
  coordinates: [number, number][];
};

export type RouteLeg = { minutes: number; meters: number };

export type WalkRoute = {
  geometry: LineString;
  legs: RouteLeg[];
  approximate: boolean;
  /** Previous path, drawn dashed and grey after a re-route. */
  ghost?: LineString;
};

export type WalkTotals = { walkMin: number; dwellMin: number; km: number };

export type WalkVersion = {
  version: number;
  reason: RerouteReason;
  createdAt: string;
  route: WalkRoute;
  totals: WalkTotals;
  stops: Stop[];
};

export type Walk = {
  id: string;
  status: WalkStatus;
  mode: BudgetMode;
  budgetMin: number;
  pace: Pace;
  start: StartPoint;
  isDemo: boolean;
  mock: boolean;
  poolKey: string;
  pool?: Candidate[];
  currentVersion: number;
  versions: WalkVersion[];
  startedAt?: string;
  endedAt?: string;
  stepsNote?: string;
  /** Fixed clock for the Austin design scene, in minutes. */
  remainingMin?: number;
  /** Map user dot when it is not the start point. */
  cursor?: { lat: number; lon: number };
};

export type PlanEvent =
  | { type: "step"; data: { text: string } }
  | { type: "stop"; data: Stop }
  | { type: "route"; data: WalkRoute }
  | { type: "walk"; data: Walk }
  | { type: "error"; data: { code: string; message: string } };

export type RerouteDiff = {
  removed: string[];
  added: string[];
  reordered: boolean;
  deltaMin: number;
};

export type WeatherSnap = {
  tempF: number;
  code: number;
  precipProbNext3h: number;
  isRainy: boolean;
};

export type ContextSnap = {
  localTime: string;
  weekday: string;
  tz: string;
  weather?: WeatherSnap;
};
