"use client";

import { useParams } from "next/navigation";
import { StopDetailScreen } from "@/components/stop/stop-detail-screen";

export default function Page() {
  const params = useParams<{ entityId: string }>();
  const entityId = decodeURIComponent(params.entityId);
  return <StopDetailScreen entityId={entityId} />;
}
