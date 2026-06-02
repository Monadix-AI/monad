import { redirect } from 'next/navigation';

export function generateStaticParams() {
  return [{ channelId: '__monad_static_export__' }];
}

export default async function ChannelPage({ params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  redirect(`/workplace/projects/${encodeURIComponent(channelId)}`);
}
