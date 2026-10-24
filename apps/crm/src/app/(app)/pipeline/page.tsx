import { Database } from "lucide-react";
import { getBoard, type BoardStage } from "@/server/pipeline";
import { PageHeader } from "@/components/page-header";
import { Board } from "@/components/pipeline/board";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  let board: BoardStage[] | null = null;
  let error: string | null = null;
  try {
    board = await getBoard();
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] md:h-screen flex-col">
      <PageHeader title="Pipeline" subtitle="Arrastra los leads entre etapas" />

      {error ? (
        <SetupState detail={error} />
      ) : board && board.length === 0 ? (
        <SetupState detail="No hay etapas todavía. Corre el seed para crear el pipeline inicial." />
      ) : (
        <Board initial={board!} />
      )}
    </div>
  );
}

function SetupState({ detail }: { detail: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-border bg-bg-panel p-8 text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-bg-elevated text-fg-muted">
          <Database className="h-5 w-5" />
        </div>
        <h2 className="mb-1 text-sm font-semibold text-fg">Falta preparar la base de datos</h2>
        <p className="mb-4 text-sm text-fg-subtle">{detail}</p>
        <div className="rounded-md bg-bg-subtle p-3 text-left font-mono text-xs text-fg-muted">
          docker compose -f docker-compose.dev.yml up -d
          <br />
          npm run db:migrate
          <br />
          npm run db:seed
        </div>
      </div>
    </div>
  );
}
