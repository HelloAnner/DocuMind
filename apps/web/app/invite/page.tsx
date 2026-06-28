import { Suspense } from "react";
import { InviteAcceptView } from "@/components/views/invite-accept";

export default function InvitePage() {
  return (
    <Suspense fallback={null}>
      <InviteAcceptView />
    </Suspense>
  );
}
