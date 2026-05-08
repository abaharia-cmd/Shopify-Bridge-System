type StageState = "ok" | "degraded" | "down";

export interface PipelineState {
  shopifyApi: StageState;
  transform: StageState;
  supabase: StageState;
}

const COLOR: Record<StageState, string> = {
  ok: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-rose-500",
};

function Stage({ name, state }: { name: string; state: StageState }) {
  return (
    <div className="flex flex-1 items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
      <span className={`h-2.5 w-2.5 rounded-full ${COLOR[state]}`} />
      <div className="flex flex-col">
        <span className="text-sm font-medium text-zinc-100">{name}</span>
        <span className="text-xs capitalize text-zinc-500">{state}</span>
      </div>
    </div>
  );
}

export function Pipeline({ state }: { state: PipelineState }) {
  return (
    <div className="flex items-center gap-2">
      <Stage name="Shopify API" state={state.shopifyApi} />
      <span className="text-zinc-600">→</span>
      <Stage name="Transform" state={state.transform} />
      <span className="text-zinc-600">→</span>
      <Stage name="Supabase" state={state.supabase} />
    </div>
  );
}
