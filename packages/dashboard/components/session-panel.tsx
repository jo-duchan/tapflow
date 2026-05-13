import { Film, MessageSquare } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CommentPanel } from '@/components/comment-panel'
import { RecordingsList } from '@/components/RecordingsList'

interface Props {
  buildId: number
  recordingsRefreshKey?: number
}

export function SessionPanel({ buildId, recordingsRefreshKey = 0 }: Props) {
  return (
    <Tabs defaultValue="comments" className="flex h-full flex-col">
      <TabsList className="w-full shrink-0">
        <TabsTrigger value="comments" className="flex-1 gap-1.5">
          <MessageSquare className="h-3.5 w-3.5" />
          Comments
        </TabsTrigger>
        <TabsTrigger value="recordings" className="flex-1 gap-1.5">
          <Film className="h-3.5 w-3.5" />
          Recordings
        </TabsTrigger>
      </TabsList>

      <TabsContent value="comments" className="mt-3 min-h-0 flex-1 overflow-hidden">
        <CommentPanel buildId={buildId} />
      </TabsContent>

      <TabsContent value="recordings" className="mt-3 min-h-0 flex-1 overflow-y-auto">
        <RecordingsList buildId={buildId} refreshKey={recordingsRefreshKey} />
      </TabsContent>
    </Tabs>
  )
}
