import ShareClientPage from "./client-page";

export function generateStaticParams() {
  return [{ token: "__placeholder__" }];
}

export default function SharePage() {
  return <ShareClientPage />;
}
