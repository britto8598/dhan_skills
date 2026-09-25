import ClientTerminal from "@/components/ClientTerminal";

export default async function PopoutPage({ searchParams }: { searchParams: Promise<{ screen?: string }> }) {
  const { screen } = await searchParams;
  return <ClientTerminal screen={screen === "2" ? 2 : 1} />;
}
