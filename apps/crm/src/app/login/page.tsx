"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    setLoading(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return setErr(d.error ?? "No se pudo iniciar sesión.");
    }
    // El servidor ya puso la cookie; recargamos hacia el tablero.
    router.replace("/pipeline");
    router.refresh();
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg p-4">
      {/*
        Marca de agua: el isotipo a gran tamaño detrás del formulario. Va con
        opacidad muy baja porque tiene que leerse como textura, no competir con
        los campos. `pointer-events-none` para que no robe clics al formulario.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <Image
          src="/brand/isotipo-wa.svg"
          alt=""
          width={900}
          height={1011}
          priority
          className="w-[min(96vw,620px)] max-w-none opacity-[0.10] md:w-[min(78vw,620px)] md:opacity-[0.07]"
        />
      </div>

      {/*
        Un velo radial apaga la marca de agua justo detrás de la tarjeta: sin él,
        los trazos del hexágono cruzan las etiquetas y molestan al leer.

        Solo en pantallas anchas. En un móvil de 390px un velo de ese tamaño cubre
        TODO el ancho y borra la marca de agua entera; ahí basta el desenfoque de
        la propia tarjeta para separar el texto del fondo.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hidden md:block"
        style={{
          background:
            "radial-gradient(ellipse 420px 380px at 50% 50%, hsl(var(--bg)/0.82), transparent 70%)",
        }}
      />

      <form
        onSubmit={submit}
        className="relative w-full max-w-sm animate-fade-in rounded-xl border border-border/70 bg-bg-panel/70 p-8 shadow-lift backdrop-blur-md"
      >
        <div className="mb-7 flex flex-col items-center text-center">
          <Image
            src="/brand/logotipo-wasuite.svg"
            alt="Wa Suite"
            width={880}
            height={280}
            priority
            className="h-11 w-auto"
          />
          <p className="mt-3 text-xs text-fg-subtle">Inicia sesión para continuar</p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-fg-muted">Usuario</label>
            <Input
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-fg-muted">Contraseña</label>
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>

        {err && <p className="mt-3 text-xs text-danger">⚠ {err}</p>}

        <Button type="submit" disabled={loading} className="mt-5 w-full">
          {loading ? "Entrando…" : "Entrar"}
        </Button>
      </form>
    </div>
  );
}
