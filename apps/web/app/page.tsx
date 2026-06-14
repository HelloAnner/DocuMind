import { ConversationProvider } from "@/components/providers/conversation-provider";
import { ChatSidebar } from "@/components/ui/chat-sidebar";
import { ChatWorkspace } from "@/components/views/chat-workspace";

export default function HomePage() {
  return (
    <ConversationProvider>
      <main className="dm-chat-shell">
        <ChatSidebar />
        <ChatWorkspace />
      </main>
    </ConversationProvider>
  );
}
