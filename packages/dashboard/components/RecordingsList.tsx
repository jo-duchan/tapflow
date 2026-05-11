'use client';

import { useEffect, useState } from 'react';
import { Download, Film } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Recording } from '@/lib/types';

interface Props {
  sessionId: string;
  refreshKey?: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatExpiry(iso: string): { label: string; urgent: boolean } {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return { label: '만료됨', urgent: true };
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return { label: '1시간 미만', urgent: true };
  if (h < 24) return { label: `${h}시간 후 만료`, urgent: h < 6 };
  return { label: `${Math.floor(h / 24)}일 후 만료`, urgent: false };
}

export function RecordingsList({ sessionId, refreshKey }: Props) {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/v1/recordings?sessionId=${encodeURIComponent(sessionId)}`, {
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: Recording[]) => setRecordings(data))
      .catch(() => setRecordings([]))
      .finally(() => setLoading(false));
  }, [sessionId, refreshKey]);

  if (loading) {
    return <p className="text-xs text-muted-foreground">녹화 목록 로딩 중...</p>;
  }

  if (recordings.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
        <Film className="h-3.5 w-3.5 shrink-0" />
        <span>이 세션의 녹화가 없습니다</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {recordings.map((rec) => {
        const expiry = formatExpiry(rec.expiresAt);
        return (
          <div
            key={rec.id}
            className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
          >
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-xs font-medium truncate">{formatDate(rec.createdAt)}</span>
              <span className={`text-xs ${expiry.urgent ? 'text-destructive' : 'text-muted-foreground'}`}>
                {expiry.label} · {formatBytes(rec.fileSize)}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 ml-2"
              title="다운로드"
              onClick={() => {
                const a = document.createElement('a');
                a.href = rec.url;
                a.download = '';
                a.click();
              }}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
