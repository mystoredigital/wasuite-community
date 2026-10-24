import { redirect } from "next/navigation";

// La raíz lleva directo al pipeline, que es el corazón del CRM.
export default function Home() {
  redirect("/pipeline");
}
