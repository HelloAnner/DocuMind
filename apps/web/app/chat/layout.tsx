import { ChatSidebar } from "@/components/ui/chat-sidebar";
import { ConversationProvider } from "@/components/providers/conversation-provider";

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ConversationProvider>
      <main className="dm-chat-shell">
        <ChatSidebar />
        {children}
      </main>
    </ConversationProvider>
  );
}
