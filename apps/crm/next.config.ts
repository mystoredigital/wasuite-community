import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Salida standalone: la imagen de Docker copia solo lo necesario para correr,
  // sin arrastrar node_modules entero. Clave para el deploy en Dokploy.
  output: "standalone",
  reactStrictMode: true,
};

export default nextConfig;
