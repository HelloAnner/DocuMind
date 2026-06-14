import { ChatDetailClient } from "./chat-detail-client";

export function generateStaticParams() {
  return [{ id: "new" }];
}

export default function ChatDetailPage() {
  return <ChatDetailClient />;
}
