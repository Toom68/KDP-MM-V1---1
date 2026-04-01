import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles,
  Wand2,
  Download,
  Zap,
  Eye,
  Scissors,
  Menu,
  X,
  ChevronLeft,
  ChevronRight,
  PenLine,
  FileEdit,
  Palette,
  Upload,
  BarChart3,
  Settings,
  KeyRound,
  DollarSign,
  BookOpen,
} from 'lucide-react';

type PageKey = 'write' | 'live' | 'library' | 'edit' | 'design' | 'publish' | 'analytics' | 'settings';
type ProviderKey = 'openai' | 'anthropic';

type ApiKeys = {
  openai?: string;
  anthropic?: string;
  gemini?: string;
};

type Book = {
  id: number;
  title: string;
  genre: string;
  chapters: number;
  words: number;
  color: string;
  rotation: number;
};

type RunStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

type AgentFeedEvent = {
  id: string;
  at: string;
  type: string;
  agentId?: string;
  agentName?: string;
  stage?: string;
  message?: string;
  progress?: number;
  chunk?: string;
  wordDelta?: number;
  chapterIndex?: number;
  segmentIndex?: number;
  segmentCount?: number;
  chapterCount?: number;
};

type ProjectListItem = {
  id: string;
  file: string;
  updatedAt: string;
  size: number;
};

type Project = {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  meta?: any;
  outline?: string;
  manuscript?: string;
  polish?: string;
};

const LS_KEYS = {
  provider: 'narrative.provider',
  apiKeys: 'narrative.apiKeys',
  monthlyBudgetUsd: 'narrative.monthlyBudgetUsd',
} as const;

function safeJsonParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function estimateTokensFromWords(words: number) {
  return Math.max(0, Math.round(words * 1.33));
}

function formatUsd(value: number) {
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function buildEnvFile(apiKeys: ApiKeys) {
  const openai = (apiKeys.openai ?? '').trim();
  const anthropic = (apiKeys.anthropic ?? '').trim();
  const gemini = (apiKeys.gemini ?? '').trim();

  const lines = [
    `OPENAI_API_KEY=${openai}`,
    `ANTHROPIC_API_KEY=${anthropic}`,
    `GEMINI_API_KEY=${gemini}`,
    `NARRATIVE_HOST=127.0.0.1`,
    `NARRATIVE_PORT=8787`,
  ];

  return lines.join('\n') + '\n';
}

function parseEnvText(raw: string) {
  const out: Record<string, string> = {};
  const lines = String(raw ?? '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export default function App() {
  const [activePage, setActivePage] = useState('write' as PageKey);
  const [isNavOpen, setIsNavOpen] = useState(false);

  const [provider, setProvider] = useState('anthropic' as ProviderKey);
  const [apiKeys, setApiKeys] = useState({} as ApiKeys);
  const [monthlyBudgetUsd, setMonthlyBudgetUsd] = useState(25 as number);

  const [backendKeyStatus, setBackendKeyStatus] = useState(null as null | {
    ok: boolean;
    model?: string;
    keys?: { openai?: boolean; anthropic?: boolean; gemini?: boolean };
    sourceHint?: { openai?: string; anthropic?: string; gemini?: string };
  });

  const [backendSyncLog, setBackendSyncLog] = useState('' as string);

  const [bookTitle, setBookTitle] = useState('');
  const [bookType, setBookType] = useState('fiction' as 'fiction' | 'nonfiction');
  const [genre, setGenre] = useState('');
  const [genreOther, setGenreOther] = useState('');
  const [tone, setTone] = useState('');
  const [toneOther, setToneOther] = useState('');
  const [plotPoints, setPlotPoints] = useState('');
  const [length, setLength] = useState('');
  const [lengthOther, setLengthOther] = useState('');
  const [targetWords, setTargetWords] = useState(85000);
  const [chapterCount, setChapterCount] = useState(18);
  const [reviewPasses, setReviewPasses] = useState(2);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isLibraryCollapsed, setIsLibraryCollapsed] = useState(false);
  const [showLibraryToggle, setShowLibraryToggle] = useState(true);
  const [runStatus, setRunStatus] = useState('idle' as RunStatus);
  const [runId, setRunId] = useState('');
  const [agentFeed, setAgentFeed] = useState([] as AgentFeedEvent[]);
  const [runProgress, setRunProgress] = useState(0 as number);

  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [liveManuscriptText, setLiveManuscriptText] = useState('');
  const [liveManuscriptUpdatedAt, setLiveManuscriptUpdatedAt] = useState('');
  const [liveManuscriptWordCount, setLiveManuscriptWordCount] = useState(0);
  const [liveManuscriptLastAgent, setLiveManuscriptLastAgent] = useState('');
  const [liveManuscriptLastStage, setLiveManuscriptLastStage] = useState('');
  const [liveManuscriptChapterIndex, setLiveManuscriptChapterIndex] = useState(null as null | number);
  const [liveManuscriptChapterCount, setLiveManuscriptChapterCount] = useState(null as null | number);
  const [liveManuscriptSegmentIndex, setLiveManuscriptSegmentIndex] = useState(null as null | number);
  const [liveManuscriptSegmentCount, setLiveManuscriptSegmentCount] = useState(null as null | number);
  const [showLiveManuscript, setShowLiveManuscript] = useState(true);
  const manuscriptPollerRef = useRef(0 as number);
  const lastManuscriptRef = useRef('' as string);
  const [manuscriptDelta, setManuscriptDelta] = useState({ prefix: '', delta: '', changedBy: '' } as { prefix: string; delta: string; changedBy: string });
  const [manuscriptHighlight, setManuscriptHighlight] = useState(null as null | { start: number; end: number; color: string; expiresAt: number });
  const [manuscriptWordDiff, setManuscriptWordDiff] = useState(null as null | Array<{ text: string; changed: boolean; color?: string; original?: string }>);

  const [ideaText, setIdeaText] = useState('');
  const [directiveQuestions, setDirectiveQuestions] = useState('');
  const [directiveAnswers, setDirectiveAnswers] = useState('');
  const [directiveBusy, setDirectiveBusy] = useState(false);
  const [directiveApplied, setDirectiveApplied] = useState('');

  // Global runs manager for concurrent runs
  const [activeRuns, setActiveRuns] = useState([] as Array<{
    id: string;
    title: string;
    status: 'running' | 'done' | 'error' | 'cancelled';
    stage?: string;
    progress: number;
    feed: AgentFeedEvent[];
  }>);
  const [selectedRunId, setSelectedRunId] = useState('' as string);
  const selectedRunIdRef = useRef('' as string);
  const runPollersRef = useRef({} as Record<string, number>);
  const seenRunEventIdsRef = useRef({} as Record<string, Record<string, true>>);
  const lastRunEventIdRef = useRef({} as Record<string, string>);

  const [projects, setProjects] = useState([] as ProjectListItem[]);
  const [activeProjectId, setActiveProjectId] = useState('');
  const [activeProject, setActiveProject] = useState(null as Project | null);
  const [activeManuscript, setActiveManuscript] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [isProjectLoading, setIsProjectLoading] = useState(false);
  const [isEditRunning, setIsEditRunning] = useState(false);

  const genres = ['Fantasy', 'Sci-Fi', 'Romance', 'Mystery', 'Thriller', 'Historical', 'Horror', 'Drama'];
  const tones = ['Light', 'Dark', 'Humorous', 'Serious', 'Surreal', 'Gritty'];
  const lengths = ['Novella', 'Standard', 'Epic'];

  const genreSubgenreMap: Record<string, string[]> = {
    Fantasy: ['Epic', 'Urban', 'Dark', 'YA'],
    'Sci-Fi': ['Space Opera', 'Cyberpunk', 'Post-Apocalyptic', 'Time Travel'],
    Romance: ['Contemporary', 'Historical', 'Paranormal', 'Suspense'],
    Mystery: ['Cozy', 'Hardboiled', 'Police Procedural', 'Thriller'],
    Thriller: ['Psychological', 'Crime', 'Political', 'Espionage'],
    Historical: ['Ancient', 'Medieval', 'WWII', 'Regency'],
    Horror: ['Psychological', 'Cosmic', 'Gothic', 'Body Horror'],
    Drama: ['Literary', 'Family', 'Coming-of-Age'],
  };

  const agentColor = (evt: any) => {
    const agentId = String(evt?.agentId ?? '').toLowerCase();
    const stage = String(evt?.stage ?? '').toLowerCase();
    if (agentId.includes('review') || stage === 'review') return '#F7B801';
    if (agentId.includes('editor') || stage === 'edit') return '#FF6B35';
    if (agentId.includes('writer') || stage === 'draft') return '#004E89';
    return '#111111';
  };

  const tokenizeWordsWithSpace = (text: string) => {
    const out: string[] = [];
    const re = /\S+\s*/g;
    const s = String(text ?? '');
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      out.push(m[0]);
    }
    return out;
  };

  const myersDiff = (a: string[], b: string[]) => {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    const v = new Map<number, number>();
    v.set(1, 0);
    const trace: Array<Map<number, number>> = [];

    for (let d = 0; d <= max; d += 1) {
      const vNext = new Map<number, number>();
      for (let k = -d; k <= d; k += 2) {
        let x;
        if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
          x = v.get(k + 1) ?? 0;
        } else {
          x = (v.get(k - 1) ?? 0) + 1;
        }
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) {
          x += 1;
          y += 1;
        }
        vNext.set(k, x);
        if (x >= n && y >= m) {
          trace.push(vNext);
          d = max + 1;
          break;
        }
      }
      trace.push(vNext);
      v.clear();
      for (const [k, x] of vNext.entries()) v.set(k, x);
    }

    let x = n;
    let y = m;
    const edits: Array<{ type: 'equal' | 'insert' | 'delete'; text: string }> = [];

    for (let d = trace.length - 1; d > 0; d -= 1) {
      const vMap = trace[d - 1];
      const k = x - y;
      const prevK =
        k === -d + 1 || (k !== d - 1 && (vMap.get(k - 1) ?? 0) < (vMap.get(k + 1) ?? 0)) ? k + 1 : k - 1;
      const prevX = vMap.get(prevK) ?? 0;
      const prevY = prevX - prevK;

      while (x > prevX && y > prevY) {
        edits.push({ type: 'equal', text: a[x - 1] });
        x -= 1;
        y -= 1;
      }

      if (d === 0) break;
      if (x === prevX) {
        edits.push({ type: 'insert', text: b[y - 1] });
        y -= 1;
      } else {
        edits.push({ type: 'delete', text: a[x - 1] });
        x -= 1;
      }
    }

    while (x > 0 && y > 0) {
      if (a[x - 1] === b[y - 1]) {
        edits.push({ type: 'equal', text: a[x - 1] });
        x -= 1;
        y -= 1;
      } else {
        edits.push({ type: 'delete', text: a[x - 1] });
        edits.push({ type: 'insert', text: b[y - 1] });
        x -= 1;
        y -= 1;
      }
    }
    while (x > 0) {
      edits.push({ type: 'delete', text: a[x - 1] });
      x -= 1;
    }
    while (y > 0) {
      edits.push({ type: 'insert', text: b[y - 1] });
      y -= 1;
    }

    edits.reverse();
    return edits;
  };

  const buildWordDiffSpans = (prevText: string, nextText: string, color: string) => {
    const prevTokens = tokenizeWordsWithSpace(prevText);
    const nextTokens = tokenizeWordsWithSpace(nextText);
    if (prevTokens.length > 700 || nextTokens.length > 700) return null;
    const edits = myersDiff(prevTokens, nextTokens);
    const spans: Array<{ text: string; changed: boolean; color?: string; original?: string }> = [];

    let pendingDeletes: string[] = [];
    const flushDeletesAsOriginal = () => {
      const original = pendingDeletes.join('').trim();
      pendingDeletes = [];
      return original;
    };

    for (let i = 0; i < edits.length; i += 1) {
      const e = edits[i];
      if (e.type === 'delete') {
        pendingDeletes.push(e.text);
        continue;
      }
      if (e.type === 'insert') {
        const original = pendingDeletes.length ? flushDeletesAsOriginal() : '';
        const isWord = Boolean(e.text.trim());
        spans.push({ text: e.text, changed: isWord, color: isWord ? color : undefined, original: original || undefined });
        continue;
      }
      if (pendingDeletes.length) {
        flushDeletesAsOriginal();
      }
      spans.push({ text: e.text, changed: false });
    }
    return spans;
  };

  const reviewSweep = useMemo(() => {
    const stage = String(liveManuscriptLastStage ?? '').toLowerCase();
    if (!(stage === 'review' || stage === 'qc')) return null;
    const chapIdx = typeof liveManuscriptChapterIndex === 'number' ? liveManuscriptChapterIndex : null;
    const chapCount = typeof liveManuscriptChapterCount === 'number' ? liveManuscriptChapterCount : null;
    if (!chapIdx || !chapCount) return null;
    const segIdx = typeof liveManuscriptSegmentIndex === 'number' ? liveManuscriptSegmentIndex : 0;
    const segCount = typeof liveManuscriptSegmentCount === 'number' ? liveManuscriptSegmentCount : 1;
    const fraction = Math.max(0, Math.min(1, (chapIdx - 1 + segIdx / Math.max(1, segCount)) / Math.max(1, chapCount)));
    return {
      topPct: fraction * 100,
      color: stage === 'qc' ? '#FF6B35' : '#F7B801',
    };
  }, [liveManuscriptChapterCount, liveManuscriptChapterIndex, liveManuscriptLastStage, liveManuscriptSegmentCount, liveManuscriptSegmentIndex]);

  const submitDirectiveIdea = async () => {
    if (!selectedRunId) return;
    if (!ideaText.trim()) return;
    setDirectiveBusy(true);
    setDirectiveQuestions('');
    setDirectiveAnswers('');
    setDirectiveApplied('');
    try {
      const res = await fetch(`/api/runs/${selectedRunId}/directives/questions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: ideaText, openaiApiKey: String(apiKeys.openai ?? '').trim() }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(data?.message ?? 'Failed to get questions');
      setDirectiveQuestions(String(data?.questions ?? ''));
    } catch {
      setDirectiveQuestions('');
    } finally {
      setDirectiveBusy(false);
    }
  };

  const liveNotes = useMemo(() => {
    return agentFeed
      .filter((evt: AgentFeedEvent) => {
        const stage = String(evt?.stage ?? '').toLowerCase();
        const chunk = String((evt as any)?.chunk ?? '').trim();
        if (!chunk) return false;
        return stage === 'review' || stage === 'qc' || stage === 'edit';
      })
      .slice(0, 8);
  }, [agentFeed]);

  const activeRunForResume = useMemo(() => {
    if (selectedRunId) {
      const sel = activeRuns.find((r) => r.id === selectedRunId);
      if (sel) return sel;
    }
    const last = localStorage.getItem('lastRunId') ?? '';
    if (last) {
      const found = activeRuns.find((r) => r.id === last);
      if (found) return found;
      return { id: last, title: 'Live Run', status: 'running', progress: 0, feed: [] as AgentFeedEvent[] };
    }
    return null;
  }, [activeRuns, selectedRunId]);

  const applyDirective = async () => {
    if (!selectedRunId) return;
    if (!ideaText.trim() || !directiveAnswers.trim()) return;
    setDirectiveBusy(true);
    try {
      const res = await fetch(`/api/runs/${selectedRunId}/directives/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ideaText, answersText: directiveAnswers, openaiApiKey: String(apiKeys.openai ?? '').trim() }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(data?.message ?? 'Failed to apply directive');
      setDirectiveApplied(String(data?.directive ?? ''));
    } catch {
      setDirectiveApplied('');
    } finally {
      setDirectiveBusy(false);
    }
  };

  const nonfictionGenreSubgenreMap: Record<string, string[]> = {
    Business: ['Entrepreneurship', 'Marketing', 'Management', 'Finance'],
    'Self-Help': ['Productivity', 'Mindfulness', 'Relationships', 'Career'],
    Tech: ['AI', 'Programming', 'Data Science', 'Cybersecurity'],
    Health: ['Fitness', 'Nutrition', 'Mental Health', 'Chronic Illness'],
    History: ['Ancient', 'Modern', 'Military', 'Cultural'],
    Science: ['Physics', 'Biology', 'Chemistry', 'Astronomy'],
  };

  const [subgenre, setSubgenre] = useState('');
  const [subgenreOther, setSubgenreOther] = useState('');
  const effectiveSubgenre = subgenreOther.trim() || subgenre;

  useEffect(() => {
    const savedProvider = safeJsonParse<ProviderKey>(localStorage.getItem(LS_KEYS.provider));
    if (savedProvider === 'openai' || savedProvider === 'anthropic') setProvider(savedProvider);

    const savedKeys = safeJsonParse<ApiKeys>(localStorage.getItem(LS_KEYS.apiKeys));
    if (savedKeys && typeof savedKeys === 'object') setApiKeys(savedKeys);

    const savedBudget = safeJsonParse<number>(localStorage.getItem(LS_KEYS.monthlyBudgetUsd));
    if (typeof savedBudget === 'number' && Number.isFinite(savedBudget)) setMonthlyBudgetUsd(savedBudget);
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_KEYS.provider, JSON.stringify(provider));
  }, [provider]);

  useEffect(() => {
    localStorage.setItem(LS_KEYS.apiKeys, JSON.stringify(apiKeys));
  }, [apiKeys]);

  const refreshBackendConfig = async () => {
    const browserOpenAi = Boolean(String(apiKeys.openai ?? '').trim());
    try {
      const res = await fetch('/api/config');
      const text = await res.text();
      const data = safeJsonParse<any>(text) ?? null;
      const merged = {
        ok: Boolean(data?.ok ?? true),
        model: data?.model,
        keys: {
          openai: browserOpenAi || Boolean(data?.keys?.openai),
          anthropic: Boolean(data?.keys?.anthropic),
          gemini: Boolean(data?.keys?.gemini),
        },
        sourceHint: {
          openai: browserOpenAi ? 'browser' : data?.sourceHint?.openai ?? 'missing',
          anthropic: data?.sourceHint?.anthropic ?? 'missing',
          gemini: data?.sourceHint?.gemini ?? 'missing',
        },
      };
      if (res.ok) setBackendKeyStatus(merged);
      setBackendSyncLog(`GET /api/config -> ${res.status}\n${text}`);
      return merged;
    } catch {
      setBackendSyncLog('GET /api/config -> NETWORK ERROR');
      const fallback = {
        ok: browserOpenAi,
        model: undefined,
        keys: { openai: browserOpenAi, anthropic: false, gemini: false },
        sourceHint: { openai: browserOpenAi ? 'browser' : 'missing', anthropic: 'unknown', gemini: 'unknown' },
      };
      setBackendKeyStatus(fallback);
      return fallback;
    }
  };

  const syncAndVerifyBackendKeys = async () => {
    const data = await refreshBackendConfig();
    return Boolean(String(apiKeys.openai ?? '').trim() || data?.keys?.openai);
  };

  useEffect(() => {
    void refreshBackendConfig();
  }, [apiKeys.openai]);

  useEffect(() => {
    void refreshProjects();
  }, []);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    const lastRun = localStorage.getItem('lastRunId') ?? '';
    if (!lastRun || selectedRunIdRef.current) return;

    setSelectedRunId(lastRun);
    selectedRunIdRef.current = lastRun;
    setRunId(lastRun);
  }, []);

  useEffect(() => {
    const fromUrl = (() => {
      try {
        const params = new URLSearchParams(window.location.search);
        return String(params.get('run') ?? '').trim();
      } catch {
        return '';
      }
    })();

    if (!fromUrl || selectedRunIdRef.current) return;
    setSelectedRunId(fromUrl);
    selectedRunIdRef.current = fromUrl;
    setRunId(fromUrl);
    localStorage.setItem('lastRunId', fromUrl);
  }, []);

  useEffect(() => {
    if (!selectedRunId) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('run', selectedRunId);
      window.history.replaceState({}, '', url.toString());
    } catch {
      // ignore
    }
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) return;
    startRunPolling(selectedRunId);
    return () => stopRunPolling(selectedRunId);
  }, [selectedRunId]);

  useEffect(() => {
    return () => {
      for (const timerId of Object.values(runPollersRef.current)) {
        window.clearInterval(timerId);
      }
      runPollersRef.current = {};
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_KEYS.monthlyBudgetUsd, JSON.stringify(monthlyBudgetUsd));
  }, [monthlyBudgetUsd]);

  const effectiveGenre = genreOther.trim() || genre;
  const effectiveTone = toneOther.trim() || tone;
  const effectiveLength = lengthOther.trim() || length;

  useEffect(() => {
    const normalized = effectiveLength.trim().toLowerCase();
    if (normalized === 'novella') {
      setTargetWords(60000);
      setChapterCount(12);
      setReviewPasses(1);
      return;
    }
    if (normalized === 'epic') {
      setTargetWords(120000);
      setChapterCount(24);
      setReviewPasses(3);
      return;
    }
    if (normalized === 'standard') {
      setTargetWords(85000);
      setChapterCount(18);
      setReviewPasses(2);
    }
  }, [effectiveLength]);

  const pushRunEvent = (targetRunId: string, evt: any) => {
    const backendId = typeof evt?.id === 'string' ? evt.id : '';
    if (backendId) {
      const seen = (seenRunEventIdsRef.current[targetRunId] ??= {});
      if (seen[backendId]) return;
      seen[backendId] = true;
    }

    const id = backendId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const item: AgentFeedEvent = {
      id,
      at: String(evt?.at ?? new Date().toISOString()),
      type: String(evt?.type ?? 'event'),
      agentName: evt?.agentName,
      stage: evt?.stage,
      message: evt?.message,
      progress: typeof evt?.progress === 'number' ? evt.progress : undefined,
      chunk: evt?.chunk,
      wordDelta: evt?.wordDelta,
    };

    setActiveRuns((prev) => {
      let found = false;
      const next = prev.map((run) => {
        if (run.id !== targetRunId) return run;
        found = true;
        return {
          ...run,
          status:
            item.type === 'run_completed'
              ? 'done'
              : item.type === 'run_error'
                ? 'error'
                : item.type === 'run_cancelled'
                  ? 'cancelled'
                  : run.status,
          stage: item.stage ?? run.stage,
          progress: typeof item.progress === 'number' ? item.progress : run.progress,
          feed: [item, ...run.feed].slice(0, 120),
        };
      });

      if (found) return next;

      return [
        {
          id: targetRunId,
          title: String(evt?.title ?? targetRunId),
          status: item.type === 'run_completed' ? 'done' : item.type === 'run_error' ? 'error' : item.type === 'run_cancelled' ? 'cancelled' : 'running',
          stage: item.stage,
          progress: typeof item.progress === 'number' ? item.progress : 0,
          feed: [item],
        },
        ...next,
      ];
    });

    if (selectedRunIdRef.current === targetRunId) {
      setAgentFeed((prev: AgentFeedEvent[]) => [item, ...prev].slice(0, 120));
      if (typeof item.progress === 'number') setRunProgress(item.progress);
      if (item.type === 'run_completed') setRunStatus('done');
      if (item.type === 'run_cancelled') setRunStatus('cancelled');
      if (item.type === 'run_error') setRunStatus('error');
    }
  };

  const stopRunPolling = (targetRunId: string) => {
    const timerId = runPollersRef.current[targetRunId];
    if (typeof timerId === 'number') {
      window.clearInterval(timerId);
      delete runPollersRef.current[targetRunId];
    }
  };

  const startRunPolling = (targetRunId: string) => {
    stopRunPolling(targetRunId);

    const syncRun = async () => {
      try {
        const res = await fetch(`/api/runs/${targetRunId}`);
        const data = (await res.json()) as any;
        if (!res.ok) throw new Error(data?.message ?? 'Failed to load run');

        const events = Array.isArray(data?.events) ? data.events : [];
        const lastId = lastRunEventIdRef.current[targetRunId] ?? '';
        let nextEvents = events;
        if (lastId) {
          const idx = events.findIndex((e: any) => e?.id === lastId);
          nextEvents = idx >= 0 ? events.slice(idx + 1) : events;
        }
        const tail = nextEvents.slice(-120);
        tail.forEach((evt: any) => pushRunEvent(targetRunId, evt));
        const lastEvt = events[events.length - 1];
        if (typeof lastEvt?.id === 'string') lastRunEventIdRef.current[targetRunId] = lastEvt.id;

        const nextStatus = String(data?.status ?? 'running') as RunStatus;
        const nextProgress = typeof data?.progress === 'number' ? data.progress : 0;

        setActiveRuns((prev) =>
          prev.map((run) =>
            run.id === targetRunId
              ? {
                  ...run,
                  title: String(data?.title ?? run.title),
                  status: nextStatus === 'idle' ? 'running' : nextStatus,
                  stage: String(data?.stage ?? run.stage ?? ''),
                  progress: nextProgress,
                }
              : run,
          ),
        );

        if (selectedRunIdRef.current === targetRunId) {
          setRunStatus(nextStatus === 'idle' ? 'running' : nextStatus);
          setRunProgress(nextProgress);
        }

        if (nextStatus !== 'running') {
          stopRunPolling(targetRunId);
          setIsGenerating(false);
          if (nextStatus === 'done') void refreshProjects();
        }
      } catch {
        if (!navigator.onLine) {
          return;
        }
        return;
      }
    };

    void syncRun();
    runPollersRef.current[targetRunId] = window.setInterval(syncRun, 1200);
    void syncRun();
  };

  const stopManuscriptPolling = () => {
    if (manuscriptPollerRef.current) {
      window.clearInterval(manuscriptPollerRef.current);
      manuscriptPollerRef.current = 0;
    }
  };

  const startManuscriptPolling = (targetRunId: string) => {
    stopManuscriptPolling();

    const sync = async () => {
      try {
        const res = await fetch(`/api/runs/${targetRunId}/manuscript`);
        if (!res.ok) return;
        const data = (await res.json()) as any;
        const nextText = String(data?.text ?? '');
        const prevText = lastManuscriptRef.current;
        const changedBy = String(data?.lastAgentName ?? data?.lastAgentId ?? '');
        const stage = String(data?.lastStage ?? '');
        const diffColor = agentColor({ agentId: String(data?.lastAgentId ?? data?.lastAgentName ?? ''), stage });
        if (prevText && nextText.startsWith(prevText)) {
          const delta = nextText.slice(prevText.length);
          if (delta) {
            setManuscriptDelta({ prefix: prevText, delta, changedBy });
            setManuscriptWordDiff(null);
            setManuscriptHighlight({ start: prevText.length, end: nextText.length, color: diffColor, expiresAt: Date.now() + 25000 });
          }
        } else {
          setManuscriptDelta({ prefix: nextText, delta: '', changedBy });
          setManuscriptHighlight(null);
          if (prevText && nextText && prevText !== nextText) {
            const spans = buildWordDiffSpans(prevText, nextText, diffColor);
            setManuscriptWordDiff(spans);
          } else {
            setManuscriptWordDiff(null);
          }
        }
        lastManuscriptRef.current = nextText;

        setLiveManuscriptText(nextText);
        setLiveManuscriptUpdatedAt(String(data?.updatedAt ?? ''));
        setLiveManuscriptWordCount(Number(data?.wordCount ?? 0));
        setLiveManuscriptLastAgent(String(data?.lastAgentName ?? data?.lastAgentId ?? ''));
        setLiveManuscriptLastStage(stage);
        setLiveManuscriptChapterIndex(typeof data?.chapterIndex === 'number' ? data.chapterIndex : null);
        setLiveManuscriptChapterCount(typeof data?.chapterCount === 'number' ? data.chapterCount : null);
        setLiveManuscriptSegmentIndex(typeof data?.segmentIndex === 'number' ? data.segmentIndex : null);
        setLiveManuscriptSegmentCount(typeof data?.segmentCount === 'number' ? data.segmentCount : null);
      } catch {
        // ignore transient errors (offline / temporary network loss)
      }
    };

    manuscriptPollerRef.current = window.setInterval(sync, 1500);
    void sync();
  };

  useEffect(() => {
    if (!manuscriptHighlight) return;
    const wait = Math.max(0, manuscriptHighlight.expiresAt - Date.now());
    const t = window.setTimeout(() => {
      setManuscriptHighlight((cur) => {
        if (!cur) return null;
        if (cur.expiresAt > Date.now()) return cur;
        return null;
      });
    }, wait);

    return () => window.clearTimeout(t);
  }, [manuscriptHighlight]);

  useEffect(() => {
    if (!selectedRunId) {
      stopManuscriptPolling();
      setLiveManuscriptText('');
      setLiveManuscriptUpdatedAt('');
      setLiveManuscriptWordCount(0);
      setManuscriptWordDiff(null);
      return;
    }
    startManuscriptPolling(selectedRunId);
    return () => stopManuscriptPolling();
  }, [selectedRunId]);

  const handleGenerate = async () => {
    if (!bookTitle || !effectiveGenre) return;
    if (runStatus === 'running') return;

    setIsGenerating(true);
    setRunStatus('running');
    setAgentFeed([]);
    setRunProgress(0);

    try {
      const backendOk = await syncAndVerifyBackendKeys();
      if (!backendOk) {
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        setAgentFeed((prev: AgentFeedEvent[]) =>
          [
            {
              id,
              at: new Date().toISOString(),
              type: 'run_error',
              agentName: 'System',
              stage: 'config',
              message: 'Missing OPENAI_API_KEY. Paste it in Settings or configure it in Netlify environment variables.',
              progress: 0,
            },
            ...prev,
          ].slice(0, 120),
        );
        setIsGenerating(false);
        setRunStatus('error');
        return;
      }

      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: bookTitle,
          bookType,
          genre: effectiveGenre,
          subgenre: effectiveSubgenre,
          tone: effectiveTone,
          length: effectiveLength,
          targetWords,
          chapterCount,
          reviewPasses,
          openaiApiKey: String(apiKeys.openai ?? '').trim(),
          blueprint: plotPoints,
        }),
      });

      const data = (await res.json()) as any;
      if (!res.ok || !data?.runId) throw new Error(data?.message ?? 'Failed to start run');

      const newRunId = String(data.runId);
      setRunId(newRunId);
      setSelectedRunId(newRunId);
      selectedRunIdRef.current = newRunId;
      localStorage.setItem('lastRunId', newRunId);
      setActivePage('live');
      startRunPolling(newRunId);
    } catch {
      if (!navigator.onLine) return;
      setRunStatus('error');
      setIsGenerating(false);
    }
  };

  // Switch run feed globally
  const selectRun = (runId: string) => {
    setSelectedRunId(runId);
    const run = activeRuns.find((r) => r.id === runId);
    if (run) {
      setAgentFeed(run.feed);
      setRunProgress(run.progress);
      setRunStatus(run.status);
    }
  };

  const navItems = useMemo(
    () =>
      [
        { key: 'write' as const, label: 'Write', icon: PenLine, accent: '#22FF00' },
        { key: 'live' as const, label: 'Live', icon: Eye, accent: '#F7B801' },
        { key: 'library' as const, label: 'Library', icon: BookOpen, accent: '#004E89' },
        { key: 'edit' as const, label: 'Edit', icon: FileEdit, accent: '#004E89' },
        { key: 'design' as const, label: 'Design', icon: Palette, accent: '#F7B801' },
        { key: 'publish' as const, label: 'Publish', icon: Upload, accent: '#FF6B35' },
        { key: 'analytics' as const, label: 'Analytics', icon: BarChart3, accent: '#FFFFFF' },
        { key: 'settings' as const, label: 'Settings', icon: Settings, accent: '#FFFFFF' },
      ],
    [],
  );

  const activeApiKeyPresent = provider === 'openai' ? Boolean(apiKeys.openai) : Boolean(apiKeys.anthropic);

  const [estimateWords, setEstimateWords] = useState(60000 as number);
  const [estimatePasses, setEstimatePasses] = useState(3 as number);
  const [estimateCoverImages, setEstimateCoverImages] = useState(6 as number);

  const estimatedCost = useMemo(() => {
    const tokens = estimateTokensFromWords(estimateWords);
    const totalTokens = tokens * Math.max(1, estimatePasses);

    const pricing =
      provider === 'openai'
        ? { inPer1k: 0.01, outPer1k: 0.03 }
        : { inPer1k: 0.003, outPer1k: 0.015 };

    const estimatedInputTokens = Math.round(totalTokens * 0.55);
    const estimatedOutputTokens = Math.round(totalTokens * 0.45);
    const llmCost = (estimatedInputTokens / 1000) * pricing.inPer1k + (estimatedOutputTokens / 1000) * pricing.outPer1k;

    const coverCost = estimateCoverImages * 0.04;
    const qcCost = Math.max(0.1, (tokens / 1000) * 0.002);

    const total = llmCost + coverCost + qcCost;
    return {
      tokens,
      totalTokens,
      llmCost,
      coverCost,
      qcCost,
      total,
    };
  }, [estimateCoverImages, estimatePasses, estimateWords, provider]);

  const envFile = useMemo(() => buildEnvFile(apiKeys), [apiKeys]);

  const handleDownloadEnv = () => {
    const blob = new Blob([envFile], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '.env';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleDownloadLiveManuscript = () => {
    const content = String(liveManuscriptText ?? '').trim();
    if (!content) return;
    const nameBase = (bookTitle || 'manuscript').replace(/[^a-z0-9\-\s_]/gi, '').trim() || 'manuscript';
    downloadTextFile(`${nameBase}.txt`, content);
  };

  const handleCancelRun = async (targetRunId?: string) => {
    const targetId = String(targetRunId || selectedRunId || runId || '').trim();
    if (!targetId) return;
    try {
      await fetch(`/api/runs/${targetId}/cancel`, { method: 'POST' });
    } catch {
      // ignore
    }
  };

  const handleReinitRun = async () => {
    const targetId = String(selectedRunId || runId || '').trim();
    if (!targetId) return;
    try {
      const res = await fetch(`/api/runs/${targetId}/retry-segment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ openaiApiKey: String(apiKeys.openai ?? '').trim() }),
      });
      const data = (await res.json()) as any;
      if (!res.ok || !data?.ok) return;
      setRunStatus('running');
      setIsGenerating(true);
      setActivePage('live');
      startRunPolling(targetId);
    } catch {
      // ignore
    }
  };

  const activeLiveAgentKey = useMemo(() => {
    const agentId = String(liveManuscriptLastAgent ?? '').toLowerCase();
    const stage = String(liveManuscriptLastStage ?? '').toLowerCase();
    if (agentId.includes('review') || stage === 'review') return 'reviewer';
    if (agentId.includes('qc') || stage === 'qc' || agentId.includes('editor') || stage === 'edit') return 'editor';
    if (agentId.includes('writer') || stage === 'draft') return 'writer';
    return 'writer';
  }, [liveManuscriptLastAgent, liveManuscriptLastStage]);

  const refreshProjects = async () => {
    try {
      const res = await fetch('/api/projects');
      const data = (await res.json()) as any;
      const items = Array.isArray(data?.items) ? (data.items as ProjectListItem[]) : [];
      setProjects(items);
    } catch {
      setProjects([]);
    }
  };

  const loadProject = async (projectId: string) => {
    if (!projectId) return;
    setIsProjectLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      const data = (await res.json()) as Project;
      setActiveProjectId(projectId);
      setActiveProject(data);
      setActiveManuscript(String(data?.manuscript ?? ''));
      setEditNotes(String(data?.polish ?? ''));
    } catch {
      setActiveProjectId('');
      setActiveProject(null);
      setActiveManuscript('');
      setEditNotes('');
    } finally {
      setIsProjectLoading(false);
    }
  };

  const downloadTextFile = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleDownloadManuscript = () => {
    if (!activeProjectId) return;
    downloadTextFile(`${activeProjectId}.md`, activeManuscript || '');
  };

  const handleDownloadProjectJson = () => {
    if (!activeProject) return;
    downloadTextFile(`${activeProject.id}.json`, JSON.stringify(activeProject, null, 2));
  };

  const handleSaveProject = async () => {
    if (!activeProjectId) return;
    try {
      await fetch(`/api/projects/${activeProjectId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manuscript: activeManuscript, polish: editNotes }),
      });
      await loadProject(activeProjectId);
      await refreshProjects();
    } catch {
      // ignore
    }
  };

  const handleRunEditNotes = async () => {
    if (!activeProjectId) return;
    if (!activeManuscript.trim()) return;
    setIsEditRunning(true);
    try {
      const res = await fetch(`/api/projects/${activeProjectId}/edit-notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manuscript: activeManuscript, openaiApiKey: String(apiKeys.openai ?? '').trim() }),
      });
      const data = (await res.json()) as any;
      if (res.ok && typeof data?.notes === 'string') {
        setEditNotes(data.notes);
        await handleSaveProject();
      }
    } catch {
      // ignore
    } finally {
      setIsEditRunning(false);
    }
  };

  return (
    <div className="min-h-screen w-full relative overflow-hidden bg-[#F5F1E8]">
      {activePage !== 'live' && activeRunForResume && (
        <button
          onClick={() => {
            setSelectedRunId(activeRunForResume.id);
            selectedRunIdRef.current = activeRunForResume.id;
            setRunId(activeRunForResume.id);
            localStorage.setItem('lastRunId', activeRunForResume.id);
            setActivePage('live');
          }}
          className="fixed right-4 bottom-4 z-50"
          aria-label="Resume live generation"
        >
          <div className="relative">
            <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
            <div className="relative bg-[#22FF00] border-4 border-black px-4 py-3 font-black uppercase">
              Resume Live
            </div>
          </div>
        </button>
      )}

      {/* Left Pop-Out Navigation Toggle */}
      <button
        onClick={() => setIsNavOpen(true)}
        className="fixed left-4 top-24 z-50"
        aria-label="Open navigation"
      >
        <div className="relative">
          <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
          <div className="relative bg-white border-4 border-black px-3 py-3 hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
            <Menu className="w-6 h-6" />
          </div>
        </div>
      </button>

      {/* Pop-Out Navigation Panel */}
      {isNavOpen && (
        <div className="fixed inset-0 z-[60]">
          <div
            className="absolute inset-0 bg-black/80"
            onClick={() => setIsNavOpen(false)}
          />
          <div className="absolute left-0 top-0 h-full w-[340px] bg-white border-r-4 border-black">
            <div className="p-6 border-b-4 border-black flex items-start justify-between">
              <div>
                <div className="text-4xl font-black leading-none tracking-tighter">
                  MENU<span className="text-[#FF6B35]">*</span>
                </div>
                <div className="mt-2 text-xs uppercase tracking-[0.3em] opacity-70">Navigation</div>
              </div>
              <button
                onClick={() => setIsNavOpen(false)}
                className="relative"
                aria-label="Close navigation"
              >
                <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                <div className="relative bg-white border-4 border-black p-2 hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                  <X className="w-6 h-6" />
                </div>
              </button>
            </div>

            <div className="p-6 space-y-3">
              {navItems.map((item: (typeof navItems)[number], idx: number) => {
                const Icon = item.icon;
                const isActive = activePage === item.key;
                return (
                  <button
                    key={item.key}
                    onClick={() => {
                      setActivePage(item.key);
                      setIsNavOpen(false);
                    }}
                    className={`w-full text-left relative border-4 border-black px-4 py-4 font-black uppercase transition-all hover:transform hover:translate-x-0.5 hover:translate-y-0.5 ${
                      isActive ? 'bg-black text-[#22FF00]' : 'bg-white text-black'
                    }`}
                    style={{ transform: `rotate(${idx % 2 === 0 ? -1 : 1}deg)` }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div
                          className="h-10 w-10 border-4 border-black flex items-center justify-center"
                          style={{ backgroundColor: isActive ? '#22FF00' : item.accent }}
                        >
                          <Icon className="w-5 h-5 text-black" />
                        </div>
                        <span>{item.label}</span>
                      </div>
                      <span className="text-xs opacity-70">{String(idx + 1).padStart(2, '0')}</span>
                    </div>
                  </button>
                );
              })}

              <div className="pt-6 border-t-4 border-black">
                <div className="flex items-center justify-between">
                  <div className="text-xs uppercase tracking-[0.3em] opacity-70">Provider</div>
                  <div className="flex items-center gap-2">
                    <KeyRound className="w-4 h-4" />
                    <span className="text-xs font-black uppercase">{provider}</span>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <div className="text-xs uppercase tracking-[0.3em] opacity-70">API Key</div>
                  <div className={`text-xs font-black uppercase ${activeApiKeyPresent ? 'text-[#22FF00]' : 'text-[#E71D36]'}`}>
                    {activeApiKeyPresent ? 'SET' : 'MISSING'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Global Runs Panel (visible on any page if there are active runs) */}
      {activeRuns.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[50] w-96 max-h-96 bg-white border-4 border-black shadow-2xl">
          <div className="p-4 border-b-4 border-black">
            <div className="flex items-center justify-between">
              <div className="text-lg font-black uppercase">Active Runs</div>
              <div className="px-2 py-1 bg-[#22FF00] text-black font-black text-xs border-2 border-black">
                {activeRuns.filter((r) => r.status === 'running').length}
              </div>
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {activeRuns.map((run) => (
              <button
                key={run.id}
                onClick={() => selectRun(run.id)}
                className={`w-full text-left px-4 py-3 border-b border-black transition-all hover:bg-black hover:text-[#22FF00] ${
                  selectedRunId === run.id ? 'bg-black text-[#22FF00]' : 'bg-white text-black'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="text-sm font-black uppercase truncate">{run.title}</div>
                  <div className="text-xs font-black uppercase opacity-70">{run.status}</div>
                </div>
                <div className="mt-1 text-xs opacity-70">{run.stage || 'Waiting...'}</div>
                <div className="mt-1 h-1 bg-black/20">
                  <div
                    className="h-1 bg-[#22FF00] transition-all"
                    style={{ width: `${run.progress}%` }}
                  ></div>
                </div>
              </button>
            ))}
          </div>
          <div className="p-2 border-t-4 border-black flex justify-end">
            <button
              onClick={() => {
                const running = activeRuns.find((r) => r.id === selectedRunId && r.status === 'running');
                if (running) handleCancelRun(running.id);
              }}
              disabled={!activeRuns.find((r) => r.id === selectedRunId && r.status === 'running')}
              className="relative disabled:opacity-40"
            >
              <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
              <div className="relative bg-white border-2 border-black px-2 py-1 text-xs font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                Cancel
              </div>
            </button>
          </div>
        </div>
      )}

      {/* Background Elements - Chaotic */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {/* Large Color Blocks */}
        <div className="absolute top-20 right-0 w-96 h-96 bg-[#FF6B35] opacity-40" style={{ transform: 'rotate(25deg)' }}></div>
        <div className="absolute bottom-40 left-20 w-64 h-64 bg-[#004E89] opacity-30" style={{ transform: 'rotate(-15deg)' }}></div>
        <div className="absolute top-1/3 left-1/2 w-48 h-48 bg-[#F7B801] opacity-20 rounded-full"></div>

        {/* Grid Pattern */}
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: `repeating-linear-gradient(0deg, #000 0px, #000 1px, transparent 1px, transparent 40px),
                           repeating-linear-gradient(90deg, #000 0px, #000 1px, transparent 1px, transparent 40px)`
        }}></div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&display=swap');

        @keyframes glitch {
          0%, 100% { transform: translate(0); }
          20% { transform: translate(-2px, 2px); }
          40% { transform: translate(-2px, -2px); }
          60% { transform: translate(2px, 2px); }
          80% { transform: translate(2px, -2px); }
        }

        @keyframes rotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        @keyframes fade-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .animate-fade-in {
          animation: fade-in 0.3s ease-out;
        }
      `}</style>

      {activePage === 'live' && (
        <div className="fixed inset-0 z-[80] bg-[#F5F1E8]">
          <div className="absolute inset-0 pointer-events-none opacity-[0.06]" style={{ backgroundImage: 'linear-gradient(#000 1px, transparent 1px), linear-gradient(90deg, #000 1px, transparent 1px)', backgroundSize: '32px 32px' }}></div>

          {/* Top schedule / chapter bar */}
          <div className="absolute top-0 left-0 right-0 border-b-4 border-black bg-white">
            <div className="h-[76px] border-b-4 border-black bg-white flex items-center justify-between px-6">
              <div className="flex items-center gap-4">
                <div className="text-xl font-black uppercase">Live Generation</div>
                <div className="px-3 py-1 border-2 border-black font-black text-xs uppercase bg-[#22FF00] text-black">
                  {runStatus === 'running' ? 'RUNNING' : runStatus}
                </div>
                <div className="px-3 py-1 border-2 border-black font-black text-xs uppercase bg-white">
                  {typeof liveManuscriptChapterIndex === 'number' && typeof liveManuscriptChapterCount === 'number'
                    ? `Chapter ${liveManuscriptChapterIndex}/${liveManuscriptChapterCount}`
                    : 'Chapter —'}
                </div>
                <div className="px-3 py-1 border-2 border-black font-black text-xs uppercase bg-white">
                  {liveManuscriptLastStage ? liveManuscriptLastStage : 'stage —'}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="px-3 py-1 border-2 border-black font-black text-xs uppercase bg-white">
                  {liveManuscriptWordCount.toLocaleString()} words
                </div>
                <button onClick={handleReinitRun} className="relative">
                  <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                  <div className="relative bg-[#F7B801] border-2 border-black px-3 py-2 font-black text-xs uppercase">Reinitialise AI</div>
                </button>
                <button onClick={() => setActivePage('write')} className="relative">
                  <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                  <div className="relative bg-white border-2 border-black px-3 py-2 font-black text-xs uppercase">Exit</div>
                </button>
              </div>
            </div>
          </div>

          {/* Left agent rail */}
          <div className="absolute left-0 top-[76px] bottom-0 w-[92px] border-r-4 border-black bg-white">
            <div className="p-4 space-y-4">
              <div className={`border-4 border-black p-3 transition-all ${activeLiveAgentKey === 'writer' ? 'bg-[#004E89] text-white scale-[1.05]' : 'bg-white text-black'}`}>
                <PenLine className="w-6 h-6" />
              </div>
              <div className={`border-4 border-black p-3 transition-all ${activeLiveAgentKey === 'editor' ? 'bg-[#FF6B35] text-black scale-[1.05]' : 'bg-white text-black'}`}>
                <FileEdit className="w-6 h-6" />
              </div>
              <div className={`border-4 border-black p-3 transition-all ${activeLiveAgentKey === 'reviewer' ? 'bg-[#F7B801] text-black scale-[1.05]' : 'bg-white text-black'}`}>
                <Sparkles className="w-6 h-6" />
              </div>
            </div>
          </div>

          {/* Center manuscript editor */}
          <div className="absolute left-[92px] right-[420px] top-[76px] bottom-0 p-8">
            <div className="relative h-full">
              <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
              <div className="relative h-full bg-white border-4 border-black p-6 flex flex-col">
                <div className="flex items-center justify-between">
                  <div className="text-2xl font-black uppercase">Manuscript</div>
                  <div className="flex items-center gap-3">
                    <div className="px-3 py-1 border-2 border-black font-black text-xs uppercase" style={{ background: agentColor({ agentId: liveManuscriptLastAgent, stage: liveManuscriptLastStage }), color: '#000' }}>
                      {liveManuscriptLastAgent || '...'}
                    </div>
                    <div className="text-xs font-black uppercase opacity-60">{liveManuscriptUpdatedAt ? `updated ${liveManuscriptUpdatedAt}` : ''}</div>
                  </div>
                </div>

                <div className="mt-4 flex-1 border-4 border-black bg-white p-4 overflow-y-auto whitespace-pre-wrap font-mono text-sm leading-6">
                  {manuscriptHighlight && manuscriptHighlight.expiresAt > Date.now() ? (
                    <>
                      <span>{liveManuscriptText.slice(0, manuscriptHighlight.start)}</span>
                      <span style={{ backgroundColor: `${manuscriptHighlight.color}33` }}>{liveManuscriptText.slice(manuscriptHighlight.start, manuscriptHighlight.end)}</span>
                      <span>{liveManuscriptText.slice(manuscriptHighlight.end)}</span>
                    </>
                  ) : manuscriptWordDiff && manuscriptWordDiff.length > 0 ? (
                    <>
                      {manuscriptWordDiff.map((part, idx) => {
                        if (!part.changed) return <span key={idx}>{part.text}</span>;
                        const original = String(part.original ?? '').trim();
                        const title = original ? `Original: ${original}` : '';
                        return (
                          <span
                            key={idx}
                            title={title}
                            style={{
                              backgroundColor: `${String(part.color ?? '#FF6B35')}33`,
                              borderBottom: `2px solid ${String(part.color ?? '#FF6B35')}`,
                            }}
                          >
                            {part.text}
                          </span>
                        );
                      })}
                    </>
                  ) : (
                    <span>{liveManuscriptText || 'Waiting for first snapshot...'}</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Top-right Agent Feed HUD */}
          <div className="absolute top-[92px] right-6 w-[380px]">
            <div className="relative">
              <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
              <div className="relative bg-white border-4 border-black p-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-black uppercase">Agent Feed</div>
                  <div className="flex items-center gap-2">
                    <div className="px-2 py-1 border-2 border-black font-black text-[10px] uppercase bg-[#F7B801]">{runProgress}%</div>
                    <button onClick={() => handleCancelRun()} disabled={runStatus !== 'running'} className="relative disabled:opacity-40">
                      <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                      <div className="relative bg-white border-2 border-black px-2 py-1 font-black text-[10px] uppercase">Cancel</div>
                    </button>
                  </div>
                </div>

                <div className="mt-3 h-2 border-2 border-black bg-white">
                  <div className="h-full bg-[#22FF00]" style={{ width: `${runProgress}%` }}></div>
                </div>

                <div className="mt-3 text-xs font-black uppercase opacity-70 truncate">
                  {agentFeed[0]?.message ? String(agentFeed[0].message) : 'Waiting...'}
                </div>
              </div>
            </div>
          </div>

          {/* Thoughts between feed HUD and Q&A */}
          <div className="absolute right-6 top-[220px] bottom-[240px] w-[380px] overflow-y-auto space-y-4">
            {liveNotes.length > 0 && (
              <div className="relative">
                <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                <div className="relative bg-white border-4 border-black p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-black uppercase">Notes</div>
                    <div className="text-[10px] font-black uppercase opacity-60">review / qc / edit</div>
                  </div>
                  <div className="mt-3 space-y-3">
                    {liveNotes.map((evt: AgentFeedEvent) => (
                      <div key={evt.id} className="border-2 border-black bg-white">
                        <div className="px-2 py-1 border-b-2 border-black flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 border border-black" style={{ background: agentColor(evt) }}></div>
                            <div className="text-[10px] font-black uppercase">{String(evt.agentName ?? evt.type)}</div>
                          </div>
                          <div className="text-[10px] font-black uppercase opacity-60">{String(evt.stage ?? '')}</div>
                        </div>
                        <div className="p-2 whitespace-pre-wrap text-xs font-mono leading-5 max-h-[140px] overflow-y-auto">
                          {String((evt as any)?.chunk ?? '').trim()}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {agentFeed.slice(0, 40).map((evt: AgentFeedEvent) => (
              <div key={evt.id} className="relative">
                <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                <div className="relative bg-white border-4 border-black p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-3 h-3 border-2 border-black" style={{ background: agentColor(evt) }}></div>
                      <div className="text-xs font-black uppercase">{(evt.agentName ?? evt.type).toString()}</div>
                    </div>
                    <div className="text-xs font-black uppercase opacity-60">{(evt.stage ?? '').toString()}</div>
                  </div>
                  <div className="mt-2 text-sm font-bold uppercase">{(evt.message ?? evt.type).toString()}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Bottom-left download */}
          <div className="absolute left-[110px] bottom-6">
            <button onClick={handleDownloadLiveManuscript} className="relative">
              <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
              <div className="relative bg-white border-4 border-black px-6 py-4 font-black uppercase flex items-center gap-3">
                <Download className="w-6 h-6" />
                Download
              </div>
            </button>
          </div>

          {/* Bottom-right Q&A */}
          <div className="absolute right-6 bottom-6 w-[380px]">
            <div className="relative">
              <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
              <div className="relative bg-white border-4 border-black p-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-black uppercase">Ideas / Q&A</div>
                  <div className="text-[10px] font-black uppercase opacity-60">run {selectedRunId ? selectedRunId.slice(0, 6) : ''}...</div>
                </div>

                <textarea
                  value={ideaText}
                  onChange={(e: any) => setIdeaText(e.target.value)}
                  placeholder="Type an idea or plot change..."
                  className="mt-3 w-full h-20 px-4 py-3 bg-white border-4 border-black text-sm font-bold placeholder:text-black/30 focus:outline-none focus:border-[#FF6B35]"
                />

                <div className="mt-3 flex items-center gap-3">
                  <button onClick={submitDirectiveIdea} disabled={directiveBusy || !ideaText.trim()} className="relative disabled:opacity-40">
                    <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                    <div className="relative bg-[#F7B801] border-2 border-black px-3 py-2 font-black text-xs uppercase">Ask</div>
                  </button>
                  <button onClick={applyDirective} disabled={directiveBusy || !ideaText.trim() || !directiveAnswers.trim()} className="relative disabled:opacity-40">
                    <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                    <div className="relative bg-[#22FF00] border-2 border-black px-3 py-2 font-black text-xs uppercase">Apply</div>
                  </button>
                </div>

                {directiveQuestions && (
                  <div className="mt-3 border-4 border-black p-3 bg-white whitespace-pre-wrap text-xs font-mono leading-5 max-h-28 overflow-y-auto">
                    {directiveQuestions}
                  </div>
                )}

                {directiveQuestions && (
                  <textarea
                    value={directiveAnswers}
                    onChange={(e: any) => setDirectiveAnswers(e.target.value)}
                    placeholder="Answer the questions briefly..."
                    className="mt-3 w-full h-16 px-4 py-3 bg-white border-4 border-black text-sm font-bold placeholder:text-black/30 focus:outline-none focus:border-[#FF6B35]"
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Content - Asymmetric Chaos */}
      <div className="relative z-10 min-h-screen">
        {/* Brutal Header Bar */}
        <div className="absolute top-0 left-0 right-0 h-2 bg-black"></div>

        {/* Ultra Chaotic Top Bar */}
        <div className="relative pt-8 px-8 pb-6 border-b-4 border-black">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[4rem] font-black leading-none tracking-tighter -ml-1">
                NARRATIVE<span className="text-[#FF6B35]">*</span>
              </div>
              <div className="flex items-center gap-4 mt-2">
                <div className="h-1 w-16 bg-black"></div>
                <span className="text-xs uppercase tracking-[0.3em]">AI Book Generator</span>
                <div className="h-1 w-16 bg-black"></div>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-2 px-4 py-2 bg-[#22FF00] border-2 border-black transform -rotate-2">
                <Zap className="w-4 h-4" />
                <span className="text-xs font-bold uppercase">ACTIVE</span>
              </div>
              <span className="text-xs opacity-60">{projects.length} BOOKS GENERATED</span>
            </div>
          </div>
        </div>

        {/* Main Grid - Brutal Asymmetry */}
        <div className="grid grid-cols-12 gap-0 min-h-[calc(100vh-180px)]">
          {/* Left Column - Massive Type */}
          <div className={`${activePage === 'live' ? 'col-span-12' : isLibraryCollapsed ? 'col-span-12' : 'col-span-7'} relative p-12 ${activePage === 'live' ? '' : isLibraryCollapsed ? '' : 'border-r-4 border-black'} overflow-y-auto`}>
            {activePage === 'write' && (
              <>
            {/* Huge Overlapping Typography */}
            <div className="relative mb-20">
              <div className="absolute -top-16 -left-8 text-[16rem] font-black leading-none opacity-10 select-none pointer-events-none" style={{ writingMode: 'vertical-rl' }}>
                CREATE
              </div>

              <div className="relative z-10 space-y-8">
                <div className="inline-block px-6 py-3 bg-black text-[#22FF00] border-4 border-[#22FF00] transform -rotate-1">
                  <div className="flex items-center gap-3">
                    <Eye className="w-5 h-5" />
                    <span className="text-sm font-bold uppercase tracking-wider">NEW PROJECT</span>
                  </div>
                </div>

                <div className="space-y-4">
                  <h1 className="text-[8rem] font-black leading-[0.85] tracking-tighter">
                    WRITE
                    <br />
                    <span className="relative inline-block">
                      YOUR
                      <div className="absolute -right-8 top-0 w-32 h-32 bg-[#FF6B35] -z-10 transform rotate-12 pointer-events-none"></div>
                    </span>
                    <br />
                    <span className="text-[#004E89]">BOOK</span>
                  </h1>
                  <div className="w-full h-3 bg-black"></div>
                </div>
              </div>
            </div>

            {/* Form - Brutal Style */}
            <div className="space-y-8 max-w-2xl">
              <div>
                <div className="flex items-center gap-4 mb-3">
                  <div className="h-8 w-8 bg-black text-white flex items-center justify-center font-bold">0</div>
                  <label className="text-2xl font-black uppercase tracking-tight">Type</label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setBookType('fiction')}
                    className={`px-4 py-4 border-4 border-black font-bold text-sm uppercase transition-all ${
                      bookType === 'fiction' ? 'bg-black text-[#22FF00]' : 'bg-white text-black hover:bg-[#F7B801]'
                    }`}
                  >
                    Fiction
                  </button>
                  <button
                    onClick={() => setBookType('nonfiction')}
                    className={`px-4 py-4 border-4 border-black font-bold text-sm uppercase transition-all ${
                      bookType === 'nonfiction' ? 'bg-black text-[#22FF00]' : 'bg-white text-black hover:bg-[#F7B801]'
                    }`}
                  >
                    Nonfiction
                  </button>
                </div>
              </div>

              {/* Title Input */}
              <div>
                <div className="flex items-center gap-4 mb-3">
                  <div className="h-8 w-8 bg-black text-white flex items-center justify-center font-bold">1</div>
                  <label className="text-2xl font-black uppercase tracking-tight">Title</label>
                </div>
                <input
                  type="text"
                  value={bookTitle}
                  onChange={(e: any) => setBookTitle(e.target.value)}
                  placeholder="THE CHRONICLES OF..."
                  className="w-full px-6 py-5 bg-white border-4 border-black text-2xl font-bold uppercase placeholder:text-black/30 focus:outline-none focus:border-[#FF6B35] transition-all"
                />
              </div>

              {/* Genre Grid */}
              <div>
                <div className="flex items-center gap-4 mb-3">
                  <div className="h-8 w-8 bg-black text-white flex items-center justify-center font-bold">2</div>
                  <label className="text-2xl font-black uppercase tracking-tight">Genre</label>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {genres.map((g, idx) => (
                    <button
                      key={g}
                      onClick={() => {
                        setGenre(g);
                        setGenreOther('');
                        setSubgenre('');
                        setSubgenreOther('');
                      }}
                      className={`relative px-4 py-4 border-4 border-black font-bold text-sm uppercase transition-all transform hover:scale-105 ${
                        effectiveGenre === g
                          ? 'bg-black text-[#22FF00]'
                          : 'bg-white text-black hover:bg-[#F7B801]'
                      }`}
                      style={{ transform: `rotate(${idx % 2 === 0 ? -1 : 1}deg)` }}
                    >
                      {g}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={genreOther}
                  onChange={(e: any) => {
                    setGenreOther(e.target.value);
                    if (e.target.value) {
                      setGenre('');
                      setSubgenre('');
                      setSubgenreOther('');
                    }
                  }}
                  placeholder="OTHER GENRE..."
                  className="mt-3 w-full px-6 py-4 bg-white border-4 border-black text-lg font-bold uppercase placeholder:text-black/30 focus:outline-none focus:border-[#F7B801] transition-all"
                />
              </div>

              {/* Subgenre */}
              <div>
                <div className="flex items-center gap-4 mb-3">
                  <div className="h-8 w-8 bg-black text-white flex items-center justify-center font-bold">2a</div>
                  <label className="text-2xl font-black uppercase tracking-tight">Subgenre</label>
                </div>
                {(effectiveGenre && genreSubgenreMap[effectiveGenre]) ? (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      {genreSubgenreMap[effectiveGenre].map((sg, idx) => (
                        <button
                          key={sg}
                          onClick={() => {
                            setSubgenre(sg);
                            setSubgenreOther('');
                          }}
                          className={`px-3 py-3 border-4 border-black font-bold text-xs uppercase transition-all ${
                            effectiveSubgenre === sg
                              ? 'bg-black text-[#22FF00]'
                              : 'bg-white text-black hover:bg-[#F7B801]/20'
                          }`}
                        >
                          {sg}
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      value={subgenreOther}
                      onChange={(e: any) => {
                        setSubgenreOther(e.target.value);
                        if (e.target.value) setSubgenre('');
                      }}
                      placeholder="OTHER SUBGENRE..."
                      className="mt-3 w-full px-4 py-3 bg-white border-4 border-black text-sm font-bold uppercase placeholder:text-black/30 focus:outline-none focus:border-[#F7B801] transition-all"
                    />
                  </>
                ) : (
                  <input
                    type="text"
                    value={subgenreOther}
                    onChange={(e: any) => setSubgenreOther(e.target.value)}
                    placeholder="Custom subgenre..."
                    className="w-full px-4 py-3 bg-white border-4 border-black text-sm font-bold uppercase placeholder:text-black/30 focus:outline-none focus:border-[#F7B801] transition-all"
                  />
                )}
              </div>

              {/* Tone Selection */}
              <div>
                <div className="flex items-center gap-4 mb-3">
                  <div className="h-8 w-8 bg-black text-white flex items-center justify-center font-bold">3</div>
                  <label className="text-2xl font-black uppercase tracking-tight">Tone</label>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {tones.map((t) => (
                    <button
                      key={t}
                      onClick={() => {
                        setTone(t);
                        setToneOther('');
                      }}
                      className={`px-4 py-4 border-4 border-black font-bold text-sm uppercase transition-all ${
                        effectiveTone === t
                          ? 'bg-[#004E89] text-white'
                          : 'bg-white text-black hover:bg-[#004E89]/20'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={toneOther}
                  onChange={(e: any) => {
                    setToneOther(e.target.value);
                    if (e.target.value) setTone('');
                  }}
                  placeholder="OTHER TONE..."
                  className="mt-3 w-full px-6 py-4 bg-white border-4 border-black text-lg font-bold uppercase placeholder:text-black/30 focus:outline-none focus:border-[#004E89] transition-all"
                />
              </div>

              {/* Length */}
              <div>
                <div className="flex items-center gap-4 mb-3">
                  <div className="h-8 w-8 bg-black text-white flex items-center justify-center font-bold">4</div>
                  <label className="text-2xl font-black uppercase tracking-tight">Length</label>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {lengths.map((l) => (
                    <button
                      key={l}
                      onClick={() => {
                        setLength(l);
                        setLengthOther('');
                      }}
                      className={`px-4 py-4 border-4 border-black font-bold text-sm uppercase transition-all ${
                        effectiveLength === l
                          ? 'bg-[#FF6B35] text-white'
                          : 'bg-white text-black hover:bg-[#FF6B35]/20'
                      }`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={lengthOther}
                  onChange={(e: any) => {
                    setLengthOther(e.target.value);
                    if (e.target.value) setLength('');
                  }}
                  placeholder="OTHER LENGTH..."
                  className="mt-3 w-full px-6 py-4 bg-white border-4 border-black text-lg font-bold uppercase placeholder:text-black/30 focus:outline-none focus:border-[#FF6B35] transition-all"
                />
                <div className="mt-4 grid grid-cols-3 gap-3">
                  <div>
                    <div className="text-xs font-black uppercase mb-2">Target Words</div>
                    <input
                      type="number"
                      min={40000}
                      max={140000}
                      step={5000}
                      value={targetWords}
                      onChange={(e: any) => setTargetWords(Math.max(40000, Math.min(140000, Number(e.target.value) || 40000)))}
                      className="w-full px-4 py-3 bg-white border-4 border-black text-base font-bold uppercase focus:outline-none focus:border-[#FF6B35] transition-all"
                    />
                  </div>
                  <div>
                    <div className="text-xs font-black uppercase mb-2">Chapters</div>
                    <input
                      type="number"
                      min={8}
                      max={40}
                      step={1}
                      value={chapterCount}
                      onChange={(e: any) => setChapterCount(Math.max(8, Math.min(40, Number(e.target.value) || 8)))}
                      className="w-full px-4 py-3 bg-white border-4 border-black text-base font-bold uppercase focus:outline-none focus:border-[#FF6B35] transition-all"
                    />
                  </div>
                  <div>
                    <div className="text-xs font-black uppercase mb-2">Review Passes</div>
                    <input
                      type="number"
                      min={1}
                      max={3}
                      step={1}
                      value={reviewPasses}
                      onChange={(e: any) => setReviewPasses(Math.max(1, Math.min(3, Number(e.target.value) || 1)))}
                      className="w-full px-4 py-3 bg-white border-4 border-black text-base font-bold uppercase focus:outline-none focus:border-[#FF6B35] transition-all"
                    />
                  </div>
                </div>
              </div>

              {/* Plot Input */}
              <div>
                <div className="flex items-center gap-4 mb-3">
                  <div className="h-8 w-8 bg-black text-white flex items-center justify-center font-bold">5</div>
                  <label className="text-2xl font-black uppercase tracking-tight">Story Blueprint</label>
                </div>
                <textarea
                  value={plotPoints}
                  onChange={(e: any) => setPlotPoints(e.target.value)}
                  placeholder="A YOUNG HERO DISCOVERS ANCIENT POWERS..."
                  rows={6}
                  className="w-full px-6 py-5 bg-white border-4 border-black text-lg font-medium uppercase placeholder:text-black/30 focus:outline-none focus:border-[#004E89] transition-all resize-none"
                />
              </div>

              {/* Generate Button - Massive */}
              <div className="relative pt-8">
                <div className="absolute -top-4 left-0 w-full h-3 bg-black"></div>
                <button
                  onClick={handleGenerate}
                  disabled={!bookTitle || !effectiveGenre || isGenerating}
                  className="relative w-full group disabled:opacity-50"
                >
                  <div className="absolute inset-0 bg-[#22FF00] transform translate-x-2 translate-y-2"></div>
                  <div className="relative bg-black text-[#22FF00] border-4 border-black py-8 px-8 flex items-center justify-center gap-4 hover:transform hover:translate-x-1 hover:translate-y-1 transition-transform">
                    {isGenerating ? (
                      <>
                        <div className="relative w-8 h-8">
                          <div className="absolute inset-0 border-4 border-[#22FF00] border-t-transparent animate-spin"></div>
                          <Sparkles className="w-8 h-8 text-[#22FF00] animate-pulse" />
                        </div>
                        <span className="text-3xl font-black uppercase tracking-tight animate-pulse">GENERATING...</span>
                      </>
                    ) : (
                      <>
                        <Wand2 className="w-8 h-8" />
                        <span className="text-3xl font-black uppercase tracking-tight">GENERATE BOOK</span>
                        <div className="w-8 h-8 border-4 border-[#22FF00]"></div>
                      </>
                    )}
                  </div>
                </button>

                <div className="mt-5">
                  <button onClick={handleReinitRun} disabled={!selectedRunId && !runId} className="relative w-full disabled:opacity-40">
                    <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                    <div className="relative bg-[#F7B801] border-4 border-black px-6 py-4 font-black uppercase flex items-center justify-center">
                      Reinitialise AI
                    </div>
                  </button>
                </div>
              </div>

              <div className="pt-8">
                <div className="relative">
                  <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                  <div className="relative bg-white border-4 border-black p-6">
                    <div className="flex items-center justify-between">
                      <div className="text-xl font-black uppercase">Agent Feed</div>
                      <div className="flex items-center gap-3">
                        {!isOnline && (
                          <div className="px-2 py-1 border-2 border-black font-black text-xs uppercase bg-[#FF6B35] text-black">
                            offline
                          </div>
                        )}
                        <div className="text-xs font-black uppercase opacity-70">{runStatus}</div>
                        <div className="px-3 py-1 border-2 border-black font-black text-xs uppercase bg-[#F7B801]">
                          {runProgress}%
                        </div>
                        <button
                          onClick={() => handleCancelRun()}
                          disabled={runStatus !== 'running'}
                          className="relative disabled:opacity-40"
                        >
                          <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                          <div className="relative bg-white border-2 border-black px-3 py-2 font-black text-xs uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                            Cancel
                          </div>
                        </button>
                      </div>
                    </div>

                    <div className="mt-5 grid grid-cols-10 gap-0 border-4 border-black">
                      <div className="col-span-10 h-3 bg-white">
                        <div className="h-3 bg-[#22FF00]" style={{ width: `${Math.max(0, Math.min(100, runProgress))}%` }}></div>
                      </div>
                    </div>

                    <div className="mt-5 max-h-64 overflow-y-auto space-y-3">
                      {agentFeed.length === 0 && (
                        <div className="border-4 border-black p-4">
                          <div className="text-xs font-black uppercase opacity-70">Waiting</div>
                          <div className="mt-1 text-sm font-bold uppercase">Start a run to see live agent actions</div>
                        </div>
                      )}

                      {agentFeed.map((evt: AgentFeedEvent, idx: number) => (
                        <div
                          key={evt.id}
                          className="relative animate-fade-in"
                          style={{ transform: `rotate(${idx % 2 === 0 ? -0.3 : 0.3}deg)` }}
                        >
                          <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                          <div className="relative bg-white border-4 border-black p-4 hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                            <div className="flex items-center justify-between">
                              <div className="text-xs font-black uppercase">
                                {(evt.agentName ?? evt.type).toString()}
                              </div>
                              <div className="flex items-center gap-2">
                                {typeof evt.wordDelta === 'number' && (
                                  <div className="px-2 py-0.5 border-2 border-black font-black text-[10px] uppercase bg-[#22FF00] text-black">
                                    {evt.wordDelta >= 0 ? '+' : ''}
                                    {evt.wordDelta}
                                  </div>
                                )}
                                <div className="text-xs font-black uppercase opacity-60">{(evt.stage ?? '').toString()}</div>
                              </div>
                            </div>
                            <div className="mt-2 text-sm font-bold uppercase">
                              {(evt.message ?? evt.type).toString()}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="pt-8">
                <div className="relative">
                  <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                  <div className="relative bg-white border-4 border-black p-6">
                    <div className="flex items-center justify-between">
                      <div className="text-xl font-black uppercase">Live Manuscript</div>
                      <div className="flex items-center gap-3">
                        <div className="px-3 py-1 border-2 border-black font-black text-xs uppercase bg-white">
                          {liveManuscriptWordCount.toLocaleString()} words
                        </div>
                        <button
                          onClick={() => setShowLiveManuscript((v) => !v)}
                          className="relative"
                        >
                          <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                          <div className="relative bg-white border-2 border-black px-3 py-2 font-black text-xs uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                            {showLiveManuscript ? 'Hide' : 'Show'}
                          </div>
                        </button>
                      </div>
                    </div>

                    {showLiveManuscript && (
                      <>
                        <div className="mt-3 text-xs font-black uppercase opacity-60">
                          {liveManuscriptUpdatedAt ? `updated ${liveManuscriptUpdatedAt}` : 'waiting for first snapshot'}
                        </div>
                        <div className="mt-4 border-4 border-black bg-white p-4 max-h-[28rem] overflow-y-auto whitespace-pre-wrap font-mono text-sm leading-6">
                          {liveManuscriptText || 'No manuscript snapshot yet.'}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
              </>
            )}

            {activePage === 'live' && (
              <div className="w-full">
                <div className="inline-block px-6 py-3 bg-black text-[#22FF00] border-4 border-[#22FF00] transform -rotate-1">
                  <div className="flex items-center gap-3">
                    <Eye className="w-5 h-5" />
                    <span className="text-sm font-bold uppercase tracking-wider">LIVE</span>
                  </div>
                </div>

                <div className="mt-10 grid grid-cols-12 gap-8">
                  <div className="col-span-7">
                    <div className="relative">
                      <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                      <div className="relative bg-white border-4 border-black p-6">
                        <div className="flex items-center justify-between">
                          <div className="text-2xl font-black uppercase">Manuscript</div>
                          <div className="flex items-center gap-3">
                            <div className="px-3 py-1 border-2 border-black font-black text-xs uppercase bg-white">
                              {liveManuscriptWordCount.toLocaleString()} words
                            </div>
                            <div className="px-3 py-1 border-2 border-black font-black text-xs uppercase" style={{ background: agentColor({ agentId: liveManuscriptLastAgent, stage: liveManuscriptLastStage }), color: '#000' }}>
                              {liveManuscriptLastAgent || '...'}
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 text-xs font-black uppercase opacity-60">
                          {liveManuscriptUpdatedAt ? `updated ${liveManuscriptUpdatedAt}` : 'waiting for first snapshot'}
                        </div>

                        <div className="mt-4 relative border-4 border-black bg-white p-4 max-h-[36rem] overflow-y-auto whitespace-pre-wrap font-mono text-sm leading-6">
                          {reviewSweep && (
                            <div
                              className="pointer-events-none absolute left-0 right-0"
                              style={{ top: `${reviewSweep.topPct}%` }}
                            >
                              <div
                                className="h-16"
                                style={{ background: `linear-gradient(to bottom, transparent, ${reviewSweep.color}33, transparent)` }}
                              ></div>
                            </div>
                          )}

                          {manuscriptDelta.delta ? (
                            <>
                              <span>{manuscriptDelta.prefix}</span>
                              <span style={{ backgroundColor: `${agentColor({ agentId: liveManuscriptLastAgent, stage: liveManuscriptLastStage })}22` }}>{manuscriptDelta.delta}</span>
                            </>
                          ) : (
                            <span>{liveManuscriptText || 'No manuscript snapshot yet.'}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="col-span-5">
                    <div className="relative">
                      <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                      <div className="relative bg-white border-4 border-black p-6">
                        <div className="flex items-center justify-between">
                          <div className="text-2xl font-black uppercase">Thoughts</div>
                          {!isOnline && (
                            <div className="px-2 py-1 border-2 border-black font-black text-xs uppercase bg-[#FF6B35] text-black">offline</div>
                          )}
                        </div>

                        <div className="mt-5 max-h-[36rem] overflow-y-auto space-y-4">
                          {agentFeed.length === 0 && (
                            <div className="border-4 border-black p-4">
                              <div className="text-xs font-black uppercase opacity-70">Waiting</div>
                              <div className="mt-1 text-sm font-bold uppercase">Start a run to see live thoughts</div>
                            </div>
                          )}

                          {agentFeed.map((evt: AgentFeedEvent) => (
                            <div key={evt.id} className="relative">
                              <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                              <div className="relative bg-white border-4 border-black p-4">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-3">
                                    <div className="w-3 h-3 border-2 border-black" style={{ background: agentColor(evt) }}></div>
                                    <div className="text-xs font-black uppercase">{(evt.agentName ?? evt.type).toString()}</div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {typeof evt.wordDelta === 'number' && (
                                      <div className="px-2 py-0.5 border-2 border-black font-black text-[10px] uppercase bg-[#22FF00] text-black">
                                        {evt.wordDelta >= 0 ? '+' : ''}
                                        {evt.wordDelta}
                                      </div>
                                    )}
                                    <div className="text-xs font-black uppercase opacity-60">{(evt.stage ?? '').toString()}</div>
                                  </div>
                                </div>
                                <div className="mt-2 text-sm font-bold uppercase">{(evt.message ?? evt.type).toString()}</div>
                                {evt.chunk && (
                                  <div className="mt-3 border-2 border-black p-3 bg-white whitespace-pre-wrap text-xs font-mono leading-5">
                                    {String(evt.chunk).slice(0, 1200)}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activePage !== 'write' && (
              <div className="max-w-3xl">
                <div className="inline-block px-6 py-3 bg-black text-[#22FF00] border-4 border-[#22FF00] transform -rotate-1">
                  <div className="flex items-center gap-3">
                    <DollarSign className="w-5 h-5" />
                    <span className="text-sm font-bold uppercase tracking-wider">{activePage} page</span>
                  </div>
                </div>

                <div className="mt-10">
                  <h1 className="text-[5rem] font-black leading-[0.9] tracking-tighter uppercase">
                    {activePage}
                    <span className="text-[#FF6B35]">*</span>
                  </h1>
                  <div className="w-full h-3 bg-black mt-6"></div>
                </div>

                {activePage === 'settings' && (
                  <div className="mt-10 space-y-10">
                    <div className="relative">
                      <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                      <div className="relative bg-white border-4 border-black p-8">
                        <div className="flex items-center justify-between">
                          <div className="text-2xl font-black uppercase">API PROVIDER</div>
                          <div className="flex items-center gap-2">
                            <KeyRound className="w-5 h-5" />
                            <span className="text-sm font-black uppercase">{provider}</span>
                          </div>
                        </div>
                        <div className="mt-6 grid grid-cols-2 gap-3">
                          <button
                            onClick={() => setProvider('anthropic')}
                            className={`px-4 py-4 border-4 border-black font-black uppercase transition-all ${
                              provider === 'anthropic' ? 'bg-black text-[#22FF00]' : 'bg-white hover:bg-[#F7B801]'
                            }`}
                          >
                            Anthropic
                          </button>
                          <button
                            onClick={() => setProvider('openai')}
                            className={`px-4 py-4 border-4 border-black font-black uppercase transition-all ${
                              provider === 'openai' ? 'bg-black text-[#22FF00]' : 'bg-white hover:bg-[#F7B801]'
                            }`}
                          >
                            OpenAI
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-6">
                      <div className="relative">
                        <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                        <div className="relative bg-white border-4 border-black p-6">
                          <div className="text-lg font-black uppercase">Anthropic API Key</div>
                          <input
                            type="password"
                            value={apiKeys.anthropic ?? ''}
                            onChange={(e: any) => setApiKeys((prev: ApiKeys) => ({ ...prev, anthropic: e.target.value }))}
                            placeholder="sk-ant-..."
                            className="mt-3 w-full px-4 py-3 bg-white border-4 border-black text-sm font-bold placeholder:text-black/30 focus:outline-none focus:border-[#004E89] transition-all"
                          />
                        </div>
                      </div>

                      <div className="relative">
                        <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                        <div className="relative bg-white border-4 border-black p-6">
                          <div className="text-lg font-black uppercase">OpenAI API Key</div>
                          <input
                            type="password"
                            value={apiKeys.openai ?? ''}
                            onChange={(e: any) => setApiKeys((prev: ApiKeys) => ({ ...prev, openai: e.target.value }))}
                            placeholder="sk-..."
                            className="mt-3 w-full px-4 py-3 bg-white border-4 border-black text-sm font-bold placeholder:text-black/30 focus:outline-none focus:border-[#004E89] transition-all"
                          />
                        </div>
                      </div>

                      <div className="relative">
                        <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                        <div className="relative bg-white border-4 border-black p-6">
                          <div className="text-lg font-black uppercase">Gemini API Key</div>
                          <input
                            type="password"
                            value={apiKeys.gemini ?? ''}
                            onChange={(e: any) => setApiKeys((prev: ApiKeys) => ({ ...prev, gemini: e.target.value }))}
                            placeholder="AIza..."
                            className="mt-3 w-full px-4 py-3 bg-white border-4 border-black text-sm font-bold placeholder:text-black/30 focus:outline-none focus:border-[#004E89] transition-all"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="relative">
                      <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                      <div className="relative bg-white border-4 border-black p-8">
                        <div className="flex items-center justify-between">
                          <div className="text-2xl font-black uppercase">Import .env</div>
                          <div className="text-xs font-bold uppercase opacity-60">Loads keys into this browser</div>
                        </div>

                        <div className="mt-6 grid grid-cols-2 gap-3">
                          <label className="relative cursor-pointer">
                            <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                            <div className="relative bg-white border-4 border-black px-4 py-3 font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                              Choose .env file
                            </div>
                            <input
                              type="file"
                              accept=".env,text/plain"
                              className="hidden"
                              onChange={async (e: any) => {
                                const file = e?.target?.files?.[0];
                                if (!file) return;
                                const text = await file.text();
                                const parsed = parseEnvText(text);
                                setApiKeys((prev: ApiKeys) => ({
                                  ...prev,
                                  openai: parsed.OPENAI_API_KEY ?? prev.openai ?? '',
                                  anthropic: parsed.ANTHROPIC_API_KEY ?? prev.anthropic ?? '',
                                  gemini: parsed.GEMINI_API_KEY ?? prev.gemini ?? '',
                                }));
                                e.target.value = '';
                              }}
                            />
                          </label>

                          <button onClick={() => refreshBackendConfig()} className="relative">
                            <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                            <div className="relative bg-white border-4 border-black px-4 py-3 font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                              Refresh API status
                            </div>
                          </button>
                        </div>

                        <div className="mt-6 border-4 border-black p-5">
                          <div className="text-xs font-black uppercase opacity-70">API key status</div>
                          <div className="mt-2 text-sm font-bold uppercase">
                            OpenAI: {backendKeyStatus?.keys?.openai ? 'SET' : 'MISSING'} ({backendKeyStatus?.sourceHint?.openai ?? 'unknown'})
                          </div>
                          <div className="mt-1 text-sm font-bold uppercase">
                            Anthropic: {backendKeyStatus?.keys?.anthropic ? 'SET' : 'MISSING'} ({backendKeyStatus?.sourceHint?.anthropic ?? 'unknown'})
                          </div>
                          <div className="mt-1 text-sm font-bold uppercase">
                            Gemini: {backendKeyStatus?.keys?.gemini ? 'SET' : 'MISSING'} ({backendKeyStatus?.sourceHint?.gemini ?? 'unknown'})
                          </div>
                        </div>

                        <div className="mt-6 border-4 border-black p-5">
                          <div className="text-xs font-black uppercase opacity-70">API status log</div>
                          <pre className="mt-3 whitespace-pre-wrap break-words text-[10px] font-bold uppercase leading-snug">
                            {backendSyncLog || 'No requests yet'}
                          </pre>
                        </div>
                      </div>
                    </div>

                    <div className="relative">
                      <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                      <div className="relative bg-white border-4 border-black p-8">
                        <div className="flex items-center justify-between">
                          <div className="text-2xl font-black uppercase">Export .env</div>
                          <button
                            onClick={handleDownloadEnv}
                            className="relative"
                            aria-label="Download .env"
                          >
                            <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                            <div className="relative bg-white border-4 border-black px-4 py-3 font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                              <div className="flex items-center gap-2">
                                <Download className="w-5 h-5" />
                                <span className="text-sm">Download</span>
                              </div>
                            </div>
                          </button>
                        </div>
                        <div className="mt-4 text-xs font-bold uppercase opacity-60">
                          Use this for local server runs or copy the OpenAI key into Netlify environment variables
                        </div>
                        <textarea
                          value={envFile}
                          readOnly
                          rows={7}
                          className="mt-5 w-full px-4 py-4 bg-white border-4 border-black text-xs font-bold uppercase placeholder:text-black/30 focus:outline-none resize-none"
                        />
                      </div>
                    </div>

                    <div className="relative">
                      <div className="absolute inset-0 bg-[#FF6B35] transform translate-x-2 translate-y-2"></div>
                      <div className="relative bg-white border-4 border-black p-8">
                        <div className="flex items-center justify-between">
                          <div className="text-2xl font-black uppercase">Cost Estimator</div>
                          <div className="text-sm font-black uppercase">{formatUsd(estimatedCost.total)}</div>
                        </div>

                        <div className="mt-6 grid grid-cols-3 gap-4">
                          <div>
                            <div className="text-xs font-black uppercase opacity-70">Words</div>
                            <input
                              type="number"
                              value={estimateWords}
                              onChange={(e: any) => setEstimateWords(Number(e.target.value) || 0)}
                              className="mt-2 w-full px-4 py-3 bg-white border-4 border-black text-sm font-bold focus:outline-none focus:border-[#FF6B35] transition-all"
                            />
                          </div>
                          <div>
                            <div className="text-xs font-black uppercase opacity-70">Passes</div>
                            <input
                              type="number"
                              min={1}
                              value={estimatePasses}
                              onChange={(e: any) => setEstimatePasses(Math.max(1, Number(e.target.value) || 1))}
                              className="mt-2 w-full px-4 py-3 bg-white border-4 border-black text-sm font-bold focus:outline-none focus:border-[#FF6B35] transition-all"
                            />
                          </div>
                          <div>
                            <div className="text-xs font-black uppercase opacity-70">Cover imgs</div>
                            <input
                              type="number"
                              min={0}
                              value={estimateCoverImages}
                              onChange={(e: any) => setEstimateCoverImages(Math.max(0, Number(e.target.value) || 0))}
                              className="mt-2 w-full px-4 py-3 bg-white border-4 border-black text-sm font-bold focus:outline-none focus:border-[#FF6B35] transition-all"
                            />
                          </div>
                        </div>

                        <div className="mt-6 grid grid-cols-4 gap-3">
                          <div className="border-4 border-black p-4">
                            <div className="text-xs font-black uppercase opacity-70">Tokens</div>
                            <div className="text-lg font-black mt-1">{estimatedCost.totalTokens.toLocaleString()}</div>
                          </div>
                          <div className="border-4 border-black p-4">
                            <div className="text-xs font-black uppercase opacity-70">LLM</div>
                            <div className="text-lg font-black mt-1">{formatUsd(estimatedCost.llmCost)}</div>
                          </div>
                          <div className="border-4 border-black p-4">
                            <div className="text-xs font-black uppercase opacity-70">Cover</div>
                            <div className="text-lg font-black mt-1">{formatUsd(estimatedCost.coverCost)}</div>
                          </div>
                          <div className="border-4 border-black p-4">
                            <div className="text-xs font-black uppercase opacity-70">QC</div>
                            <div className="text-lg font-black mt-1">{formatUsd(estimatedCost.qcCost)}</div>
                          </div>
                        </div>

                        <div className="mt-8">
                          <div className="flex items-center justify-between">
                            <div className="text-sm font-black uppercase">Monthly Budget</div>
                            <div className="text-sm font-black uppercase">{formatUsd(monthlyBudgetUsd)}</div>
                          </div>
                          <input
                            type="number"
                            min={0}
                            value={monthlyBudgetUsd}
                            onChange={(e: any) => setMonthlyBudgetUsd(Math.max(0, Number(e.target.value) || 0))}
                            className="mt-3 w-full px-4 py-3 bg-white border-4 border-black text-sm font-bold focus:outline-none focus:border-[#004E89] transition-all"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activePage === 'library' && (
                  <div className="mt-10 space-y-10">
                    <div className="relative">
                      <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                      <div className="relative bg-white border-4 border-black p-8">
                        <div className="flex items-center justify-between">
                          <div className="text-2xl font-black uppercase">Library</div>
                          <button
                            onClick={refreshProjects}
                            className="relative"
                            aria-label="Refresh library"
                          >
                            <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                            <div className="relative bg-white border-4 border-black px-4 py-3 font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                              Refresh
                            </div>
                          </button>
                        </div>

                        <div className="mt-6 grid grid-cols-2 gap-3">
                          {projects.length === 0 && (
                            <div className="border-4 border-black p-6">
                              <div className="text-sm font-black uppercase">No books yet</div>
                              <div className="mt-2 text-xs font-bold uppercase opacity-70">Generate a book to see it here</div>
                            </div>
                          )}

                          {projects.map((p: ProjectListItem, idx: number) => (
                            <button
                              key={p.id}
                              onClick={() => loadProject(p.id)}
                              className={`text-left border-4 border-black p-5 font-black uppercase transition-all hover:transform hover:translate-x-0.5 hover:translate-y-0.5 ${
                                activeProjectId === p.id ? 'bg-black text-[#22FF00]' : 'bg-white text-black'
                              }`}
                              style={{ transform: `rotate(${idx % 2 === 0 ? -1 : 1}deg)` }}
                            >
                              <div className="text-sm">{p.id}</div>
                              <div className="mt-2 text-xs opacity-70">{new Date(p.updatedAt).toLocaleString()}</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="relative">
                      <div className="absolute inset-0 bg-[#004E89] transform translate-x-2 translate-y-2"></div>
                      <div className="relative bg-white border-4 border-black p-8">
                        <div className="flex items-center justify-between">
                          <div className="text-2xl font-black uppercase">Reader</div>
                          <div className="text-xs font-black uppercase opacity-70">{isProjectLoading ? 'loading' : activeProjectId ? activeProjectId : 'no book'}</div>
                        </div>

                        <div className="mt-6">
                          <div className="text-xs font-black uppercase opacity-70">Manuscript</div>
                          <textarea
                            value={activeManuscript}
                            onChange={(e: any) => setActiveManuscript(e.target.value)}
                            rows={12}
                            className="mt-2 w-full px-4 py-4 bg-white border-4 border-black text-xs font-bold focus:outline-none resize-none"
                          />
                        </div>

                        <div className="mt-6 grid grid-cols-3 gap-3">
                          <button
                            onClick={() => setActivePage('edit')}
                            disabled={!activeProjectId}
                            className="relative disabled:opacity-40"
                          >
                            <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                            <div className="relative bg-white border-4 border-black px-4 py-4 font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                              Edit
                            </div>
                          </button>
                          <button
                            onClick={handleDownloadManuscript}
                            disabled={!activeProjectId}
                            className="relative disabled:opacity-40"
                          >
                            <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                            <div className="relative bg-white border-4 border-black px-4 py-4 font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                              Download
                            </div>
                          </button>
                          <button
                            onClick={handleDownloadProjectJson}
                            disabled={!activeProject}
                            className="relative disabled:opacity-40"
                          >
                            <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                            <div className="relative bg-white border-4 border-black px-4 py-4 font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                              Export
                            </div>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activePage === 'edit' && (
                  <div className="mt-10 space-y-10">
                    <div className="relative">
                      <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                      <div className="relative bg-white border-4 border-black p-8">
                        <div className="flex items-center justify-between">
                          <div className="text-2xl font-black uppercase">Projects</div>
                          <button
                            onClick={refreshProjects}
                            className="relative"
                            aria-label="Refresh projects"
                          >
                            <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                            <div className="relative bg-white border-4 border-black px-4 py-3 font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                              Refresh
                            </div>
                          </button>
                        </div>

                        <div className="mt-6 grid grid-cols-2 gap-3">
                          {projects.length === 0 && (
                            <div className="border-4 border-black p-6">
                              <div className="text-sm font-black uppercase">No local projects yet</div>
                              <div className="mt-2 text-xs font-bold uppercase opacity-70">Generate a book to create one</div>
                            </div>
                          )}

                          {projects.map((p: ProjectListItem, idx: number) => (
                            <button
                              key={p.id}
                              onClick={() => loadProject(p.id)}
                              className={`text-left border-4 border-black p-5 font-black uppercase transition-all hover:transform hover:translate-x-0.5 hover:translate-y-0.5 ${
                                activeProjectId === p.id ? 'bg-black text-[#22FF00]' : 'bg-white text-black'
                              }`}
                              style={{ transform: `rotate(${idx % 2 === 0 ? -1 : 1}deg)` }}
                            >
                              <div className="text-sm">{p.id}</div>
                              <div className="mt-2 text-xs opacity-70">{new Date(p.updatedAt).toLocaleString()}</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="relative">
                      <div className="absolute inset-0 bg-[#004E89] transform translate-x-2 translate-y-2"></div>
                      <div className="relative bg-white border-4 border-black p-8">
                        <div className="flex items-center justify-between">
                          <div className="text-2xl font-black uppercase">Editor</div>
                          <div className="text-xs font-black uppercase opacity-70">{isProjectLoading ? 'loading' : activeProjectId ? activeProjectId : 'no project'}</div>
                        </div>

                        <div className="mt-6">
                          <div className="text-xs font-black uppercase opacity-70">Manuscript</div>
                          <textarea
                            value={activeManuscript}
                            onChange={(e: any) => setActiveManuscript(e.target.value)}
                            rows={10}
                            className="mt-2 w-full px-4 py-4 bg-white border-4 border-black text-xs font-bold focus:outline-none resize-none"
                          />
                        </div>

                        <div className="mt-6 grid grid-cols-3 gap-3">
                          <button
                            onClick={handleSaveProject}
                            disabled={!activeProjectId}
                            className="relative disabled:opacity-40"
                          >
                            <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                            <div className="relative bg-white border-4 border-black px-4 py-4 font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                              Save
                            </div>
                          </button>
                          <button
                            onClick={handleRunEditNotes}
                            disabled={!activeProjectId || isEditRunning}
                            className="relative disabled:opacity-40"
                          >
                            <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                            <div className="relative bg-white border-4 border-black px-4 py-4 font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                              {isEditRunning ? 'Running…' : 'Edit Notes'}
                            </div>
                          </button>
                          <button
                            onClick={handleDownloadManuscript}
                            disabled={!activeProjectId}
                            className="relative disabled:opacity-40"
                          >
                            <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                            <div className="relative bg-white border-4 border-black px-4 py-4 font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                              Download
                            </div>
                          </button>
                        </div>

                        <div className="mt-6">
                          <div className="text-xs font-black uppercase opacity-70">Edit notes</div>
                          <textarea
                            value={editNotes}
                            onChange={(e: any) => setEditNotes(e.target.value)}
                            rows={8}
                            className="mt-2 w-full px-4 py-4 bg-white border-4 border-black text-xs font-bold focus:outline-none resize-none"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activePage === 'publish' && (
                  <div className="mt-10 space-y-10">
                    <div className="relative">
                      <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                      <div className="relative bg-white border-4 border-black p-8">
                        <div className="flex items-center justify-between">
                          <div className="text-2xl font-black uppercase">Publish</div>
                          <button
                            onClick={refreshProjects}
                            className="relative"
                            aria-label="Refresh projects"
                          >
                            <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                            <div className="relative bg-white border-4 border-black px-4 py-3 font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                              Refresh
                            </div>
                          </button>
                        </div>

                        <div className="mt-6">
                          <div className="text-xs font-black uppercase opacity-70">Select project</div>
                          <div className="mt-2 grid grid-cols-2 gap-3">
                            {projects.map((p: ProjectListItem, idx: number) => (
                              <button
                                key={p.id}
                                onClick={() => loadProject(p.id)}
                                className={`text-left border-4 border-black p-5 font-black uppercase transition-all hover:transform hover:translate-x-0.5 hover:translate-y-0.5 ${
                                  activeProjectId === p.id ? 'bg-black text-[#22FF00]' : 'bg-white text-black'
                                }`}
                                style={{ transform: `rotate(${idx % 2 === 0 ? -1 : 1}deg)` }}
                              >
                                <div className="text-sm">{p.id}</div>
                                <div className="mt-2 text-xs opacity-70">{new Date(p.updatedAt).toLocaleString()}</div>
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="mt-8 grid grid-cols-2 gap-3">
                          <button
                            onClick={handleDownloadManuscript}
                            disabled={!activeProjectId}
                            className="relative disabled:opacity-40"
                          >
                            <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                            <div className="relative bg-white border-4 border-black px-4 py-4 font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                              Download manuscript
                            </div>
                          </button>
                          <button
                            onClick={handleDownloadProjectJson}
                            disabled={!activeProjectId || !activeProject}
                            className="relative disabled:opacity-40"
                          >
                            <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                            <div className="relative bg-white border-4 border-black px-4 py-4 font-black uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                              Download project JSON
                            </div>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activePage !== 'settings' && (
                  <div className="mt-10">
                    <div className="relative">
                      <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                      <div className="relative bg-white border-4 border-black p-8">
                        <div className="text-xl font-black uppercase">Tip</div>
                        <div className="mt-3 text-sm font-medium uppercase opacity-70">
                          Use Settings to add your API keys, then generate real books.
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Library Toggle Button */}
          {showLibraryToggle && isLibraryCollapsed && (
            <button
              onClick={() => setIsLibraryCollapsed(false)}
              className="fixed right-4 top-24 z-40"
              aria-label="Open feed"
            >
              <div className="relative">
                <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                <div className="relative bg-white border-4 border-black px-3 py-3 hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                  <ChevronLeft className="w-6 h-6" />
                </div>
              </div>
            </button>
          )}

          {/* Right Column - Agent Feed */}
          {!isLibraryCollapsed && (
            <div className="col-span-5 relative bg-[#1a1a1a] p-8 overflow-y-auto">
              {/* Agent Feed Header */}
              <div className="mb-8 pb-6 border-b-2 border-white/20">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-5xl font-black text-white uppercase tracking-tighter">Feed</h2>
                  <button onClick={() => setIsLibraryCollapsed(true)} className="relative" aria-label="Collapse feed">
                    <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                    <div className="relative bg-white border-4 border-black p-2 hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                      <ChevronRight className="w-6 h-6" />
                    </div>
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <Zap className="w-5 h-5 text-white/60" />
                  <span className="text-sm text-white/60 uppercase tracking-wider">Live Agent Actions</span>
                </div>
              </div>

              {/* Agent Feed */}
              <div className="space-y-4">
                <div className="relative">
                  <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
                  <div className="relative bg-white border-4 border-black p-6">
                    <div className="flex items-center justify-between">
                      <div className="text-xl font-black uppercase">Agent Feed</div>
                      <div className="flex items-center gap-3">
                        <div className="text-xs font-black uppercase opacity-70">{runStatus}</div>
                        <div className="px-3 py-1 border-2 border-black font-black text-xs uppercase bg-[#F7B801]">{runProgress}%</div>
                        <button onClick={() => handleCancelRun()} disabled={runStatus !== 'running'} className="relative disabled:opacity-40">
                          <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                          <div className="relative bg-white border-2 border-black px-3 py-2 font-black text-xs uppercase hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">Cancel</div>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {agentFeed.length === 0 && (
                  <div className="border-4 border-black p-4">
                    <div className="text-xs font-black uppercase opacity-70">Waiting</div>
                    <div className="mt-1 text-sm font-bold uppercase">Start a run to see live agent actions</div>
                  </div>
                )}

                {agentFeed.map((evt: AgentFeedEvent, idx: number) => (
                  <div key={evt.id} className="relative animate-fade-in" style={{ transform: `rotate(${idx % 2 === 0 ? -0.3 : 0.3}deg)` }}>
                    <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                    <div className="relative bg-white border-4 border-black p-4 hover:transform hover:translate-x-0.5 hover:translate-y-0.5 transition-transform">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-black uppercase">{(evt.agentName ?? evt.type).toString()}</div>
                        <div className="text-xs font-black uppercase opacity-60">{(evt.stage ?? '').toString()}</div>
                      </div>
                      <div className="mt-2 text-sm font-bold uppercase">{(evt.message ?? evt.type).toString()}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Bottom Decoration */}
              <div className="mt-12 pt-8 border-t-2 border-white/20">
                <div className="flex items-center gap-4">
                  <div className="flex-1 h-2 bg-[#FF6B35]"></div>
                  <div className="flex-1 h-2 bg-[#F7B801]"></div>
                  <div className="flex-1 h-2 bg-[#004E89]"></div>
                </div>
              </div>
            </div>
          )}
        </div>

      {runStatus === 'running' && selectedRunId && (
        <div className="fixed bottom-4 left-4 z-[70] w-[420px]">
          <div className="relative">
            <div className="absolute inset-0 bg-black transform translate-x-2 translate-y-2"></div>
            <div className="relative bg-white border-4 border-black p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-black uppercase">Ideas / Q&A</div>
                <div className="text-[10px] font-black uppercase opacity-60">run {selectedRunId.slice(0, 6)}...</div>
              </div>

              <textarea
                value={ideaText}
                onChange={(e: any) => setIdeaText(e.target.value)}
                placeholder="Type an idea or plot change..."
                className="mt-3 w-full h-24 px-4 py-3 bg-white border-4 border-black text-sm font-bold placeholder:text-black/30 focus:outline-none focus:border-[#FF6B35]"
              />

              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={submitDirectiveIdea}
                  disabled={directiveBusy || !ideaText.trim()}
                  className="relative disabled:opacity-40"
                >
                  <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                  <div className="relative bg-[#F7B801] border-2 border-black px-3 py-2 font-black text-xs uppercase">
                    Ask
                  </div>
                </button>

                <button
                  onClick={applyDirective}
                  disabled={directiveBusy || !ideaText.trim() || !directiveAnswers.trim()}
                  className="relative disabled:opacity-40"
                >
                  <div className="absolute inset-0 bg-black transform translate-x-1 translate-y-1"></div>
                  <div className="relative bg-[#22FF00] border-2 border-black px-3 py-2 font-black text-xs uppercase">
                    Apply
                  </div>
                </button>
              </div>

              {directiveQuestions && (
                <div className="mt-3 border-4 border-black p-3 bg-white whitespace-pre-wrap text-xs font-mono leading-5">
                  {directiveQuestions}
                </div>
              )}

              {directiveQuestions && (
                <textarea
                  value={directiveAnswers}
                  onChange={(e: any) => setDirectiveAnswers(e.target.value)}
                  placeholder="Answer the questions briefly..."
                  className="mt-3 w-full h-20 px-4 py-3 bg-white border-4 border-black text-sm font-bold placeholder:text-black/30 focus:outline-none focus:border-[#FF6B35]"
                />
              )}

              {directiveApplied && (
                <div className="mt-3 border-4 border-black p-3 bg-white whitespace-pre-wrap text-xs font-mono leading-5">
                  {directiveApplied}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      </div>
    </div>
  );
}
