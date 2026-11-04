"use client";

import { useParams } from "next/navigation";
import { useEffect } from "react";
import { workspace } from "@/lib/workspace";

/** /app/s/<id>: shows that session in the workspace (see ../layout.tsx). */
export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  useEffect(() => {
    if (id) workspace.open(id);
  }, [id]);
  return null;
}
