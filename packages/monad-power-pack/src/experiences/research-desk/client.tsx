import type { WorkplaceExperienceHostApiV1 } from '@monad/sdk-experience';
import type { Root } from 'react-dom/client';
import type {
  ClaimDecision,
  EvidenceClaim,
  Report,
  ReportBlock,
  SourceKind,
  SourceRef,
  SourceType
} from './domain/index.ts';

import { bindWorkplaceExperience } from '@monad/sdk-experience';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';

import {
  type FocusedPane,
  firstBlockedBlock,
  parseCoverage,
  parseEvidenceMutation,
  parseEvidencePayload,
  parseOverviewPayload,
  parsePublishResult,
  parseReportMutation,
  parseReportPayload,
  parseSourceMutation,
  parseSourcesPayload,
  publishConflict,
  type ResearchOverview,
  replaceClaim,
  researchViewModel
} from './client-logic.ts';
import { CLIENT_STYLES } from './client-styles.ts';
import { EvidencePane } from './panes/evidence-pane.tsx';
import { ReportPane } from './panes/report-pane.tsx';
import {
  ActivityBar,
  AddSourceDialog,
  CreateReportDialog,
  FocusSwitcher,
  PublishBlockedDialog,
  ResearchTopbar
} from './panes/research-chrome.tsx';
import { SourcesPane } from './panes/sources-pane.tsx';

export { decisionBody, publishConflict, researchViewModel } from './client-logic.ts';

interface JsonObject {
  [key: string]: unknown;
}

class ResponseError extends Error {
  readonly response: Response;
  readonly payload: unknown;

  constructor(response: Response, payload: unknown) {
    const failure = z.object({ error: z.string() }).safeParse(payload);
    super(failure.success ? failure.data.error : `Request failed: ${response.status}`);
    this.name = 'ResponseError';
    this.response = response;
    this.payload = payload;
  }
}

function ResearchDeskApp({ host }: { host: WorkplaceExperienceHostApiV1 }) {
  const projectId = host.snapshot.projectId ?? '';
  const [overview, setOverview] = useState<ResearchOverview | null>(null);
  const [sources, setSources] = useState<SourceRef[]>([]);
  const [evidence, setEvidence] = useState<EvidenceClaim[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [coverage, setCoverage] = useState<ReturnType<typeof parseCoverage>>([]);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [focusedPane, setFocusedPane] = useState<FocusedPane>('evidence');
  const [pendingClaimIds, setPendingClaimIds] = useState(new Set<string>());
  const [pendingBlockIds, setPendingBlockIds] = useState(new Set<string>());
  const [publishing, setPublishing] = useState(false);
  const [addingSource, setAddingSource] = useState(false);
  const [creatingReport, setCreatingReport] = useState(false);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [conflict, setConflict] = useState<ReturnType<typeof publishConflict>>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [activity, setActivity] = useState<string[]>([]);
  const connectionFailed = useRef(false);
  const loadedOnce = useRef(false);

  const request = useCallback(
    async (path: string, init?: RequestInit): Promise<unknown> => {
      const response = await fetch(`${host.apiBaseUrl}${path}`, init);
      const payload = (await response.json()) as unknown;
      if (!response.ok) throw new ResponseError(response, payload);
      return payload;
    },
    [host.apiBaseUrl]
  );

  const load = useCallback(async () => {
    if (!projectId) return;
    const query = new URLSearchParams({ projectId });
    try {
      const [overviewPayload, sourcesPayload, evidencePayload, reportPayload] = await Promise.all([
        request(`/overview?${query}`),
        request(`/sources?${query}`),
        request(`/evidence?${query}`),
        request(`/report?${query}`)
      ]);
      setOverview(parseOverviewPayload(overviewPayload));
      setSources(parseSourcesPayload(sourcesPayload));
      setEvidence(parseEvidencePayload(evidencePayload));
      const nextReport = parseReportPayload(reportPayload);
      setReport(nextReport.report);
      setCoverage(nextReport.coverage);
      if (!loadedOnce.current) {
        setActivity([
          connectionFailed.current ? 'Connection restored. Research record refreshed.' : 'Research record loaded.'
        ]);
        loadedOnce.current = true;
        connectionFailed.current = false;
      } else if (connectionFailed.current) {
        setActivity((current) => [...current, 'Connection restored. Research record refreshed.']);
        connectionFailed.current = false;
      }
      setError('');
    } catch (cause) {
      connectionFailed.current = true;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId, request]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!overview || overview.stage === 'published') return;
    const timer = setInterval(() => void load(), 2_000);
    return () => clearInterval(timer);
  }, [load, overview]);

  useEffect(() => {
    if (!selectedEvidenceId && evidence[0]) setSelectedEvidenceId(evidence[0].id);
  }, [evidence, selectedEvidenceId]);

  const mutate = useCallback(
    async (path: string, body: JsonObject) => {
      return request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, ...body })
      });
    },
    [projectId, request]
  );

  const view = useMemo(
    () => researchViewModel(evidence, report, selectedEvidenceId),
    [evidence, report, selectedEvidenceId]
  );
  const sourcesById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);

  const withPendingClaim = async (claim: EvidenceClaim, operation: () => Promise<void>) => {
    setPendingClaimIds((current) => new Set(current).add(claim.id));
    try {
      await operation();
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setPendingClaimIds((current) => without(current, claim.id));
    }
  };

  const publish = async () => {
    if (!report) return;
    setPublishing(true);
    setConflict(null);
    try {
      const payload = await mutate('/report/publish', { expectedVersion: report.version });
      const result = parsePublishResult(payload);
      setReport(result.report);
      setActivity((current) => [
        ...current,
        result.published ? `Published report revision ${result.report.revision}.` : 'Publish approval was canceled.'
      ]);
      setError('');
    } catch (cause) {
      if (cause instanceof ResponseError && cause.response.status === 409) {
        const next = publishConflict(cause.payload);
        if (next) {
          setConflict(next);
          const blockId = firstBlockedBlock(next);
          if (blockId) setSelectedBlockId(blockId);
          setFocusedPane('report');
          return;
        }
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <main className="research-app">
      {error ? (
        <div
          className="error-banner"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      <ResearchTopbar
        onPublish={() => void publish()}
        overview={overview}
        publishing={publishing}
        report={report}
      />
      <FocusSwitcher
        focused={focusedPane}
        onFocus={setFocusedPane}
      />
      {loading ? (
        <div className="panes">
          {(['Sources', 'Evidence', 'Report'] as const).map((label) => (
            <section
              aria-label={label}
              className="pane"
              data-focused={label.toLowerCase() === focusedPane}
              key={label}
            >
              <header className="pane-header">
                <h2 className="pane-heading">{label}</h2>
              </header>
              <div className="pane-body">
                <div className="loading-card">
                  <span className="skeleton" />
                  <span
                    className="skeleton"
                    data-size="medium"
                  />
                  <span
                    className="skeleton"
                    data-size="small"
                  />
                </div>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="panes">
          <SourcesPane
            focused={focusedPane === 'sources'}
            linkedSourceIds={view.linkedSourceIds}
            onAdd={() => setSourceDialogOpen(true)}
            onInspect={(source) => {
              void mutate('/sources/inspect', { sourceId: source.id })
                .then((payload) => {
                  const updated = parseSourceMutation(payload);
                  setSources((current) => replaceSource(current, updated));
                  setActivity((current) => [...current, `Inspected source: ${updated.title}.`]);
                })
                .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
            }}
            sources={sources}
          />
          <EvidencePane
            claims={evidence}
            focused={focusedPane === 'evidence'}
            onDecide={(claim, decision: ClaimDecision) =>
              withPendingClaim(claim, async () => {
                const payload = await mutate('/evidence/decide', {
                  evidenceId: claim.id,
                  expectedVersion: claim.version,
                  ...decision
                });
                const updated = parseEvidenceMutation(payload);
                setEvidence((current) => replaceClaim(current, updated));
                setCoverage(parseCoverage(payload));
                setActivity((current) => [
                  ...current,
                  `${decision.status === 'accepted' ? 'Accepted' : 'Rejected'} evidence: ${updated.id}.`
                ]);
              })
            }
            onRerun={(claim) =>
              withPendingClaim(claim, async () => {
                const payload = await mutate('/evidence/rerun', { evidenceId: claim.id });
                const updated = parseEvidenceMutation(payload);
                setEvidence((current) => replaceClaim(current, updated));
                setActivity((current) => [...current, `Re-ran verification for evidence: ${updated.id}.`]);
              })
            }
            onSelect={(claimId) => {
              setSelectedEvidenceId(claimId);
              setFocusedPane('evidence');
            }}
            pendingClaimIds={pendingClaimIds}
            selectedClaim={view.selectedClaim}
            sourcesById={sourcesById}
          />
          <ReportPane
            coverage={coverage}
            focused={focusedPane === 'report'}
            linkedReportBlockIds={view.linkedReportBlockIds}
            onCreate={() => setReportDialogOpen(true)}
            onSave={async (block: ReportBlock, patch) => {
              if (!report) return;
              setPendingBlockIds((current) => new Set(current).add(block.id));
              try {
                const payload = await mutate('/report/blocks/patch', {
                  blockId: block.id,
                  expectedVersion: report.version,
                  patch
                });
                setReport(parseReportMutation(payload));
                setCoverage(parseCoverage(payload));
                setActivity((current) => [...current, `Updated report block: ${block.heading}.`]);
              } finally {
                setPendingBlockIds((current) => without(current, block.id));
              }
            }}
            onSelect={(blockId) => {
              setSelectedBlockId(blockId);
              setFocusedPane('report');
            }}
            onSelectEvidence={(claimId) => {
              setSelectedEvidenceId(claimId);
              setFocusedPane('evidence');
            }}
            pendingBlockIds={pendingBlockIds}
            report={report}
            selectedBlockId={selectedBlockId}
          />
        </div>
      )}
      <ActivityBar activity={activity} />
      {sourceDialogOpen ? (
        <AddSourceDialog
          onClose={() => setSourceDialogOpen(false)}
          onSubmit={async (source: { kind: SourceKind; type: SourceType; title: string; locator: string }) => {
            setAddingSource(true);
            try {
              const payload = await mutate('/sources/add', source);
              const added = parseSourceMutation(payload);
              setSources((current) => replaceSource(current, added));
              setActivity((current) => [...current, `Added source: ${added.title}.`]);
              setSourceDialogOpen(false);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setAddingSource(false);
            }
          }}
          pending={addingSource}
        />
      ) : null}
      {reportDialogOpen ? (
        <CreateReportDialog
          onClose={() => setReportDialogOpen(false)}
          onSubmit={async (brief) => {
            setCreatingReport(true);
            try {
              const payload = await mutate('/report/create', brief);
              setReport(parseReportMutation(payload));
              setCoverage(parseCoverage(payload));
              setActivity((current) => [...current, `Started research brief: ${brief.title}.`]);
              setReportDialogOpen(false);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setCreatingReport(false);
            }
          }}
          pending={creatingReport}
        />
      ) : null}
      {conflict ? (
        <PublishBlockedDialog
          conflict={conflict}
          onClose={() => setConflict(null)}
          onGoToBlock={(blockId) => {
            setSelectedBlockId(blockId);
            setFocusedPane('report');
            setConflict(null);
          }}
        />
      ) : null}
    </main>
  );
}

function without(values: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(values);
  next.delete(value);
  return next;
}

function replaceSource(sources: readonly SourceRef[], updated: SourceRef): SourceRef[] {
  const index = sources.findIndex((source) => source.id === updated.id);
  if (index === -1) return [...sources, updated];
  return sources.with(index, updated);
}

const HTMLElementBase: typeof HTMLElement = globalThis.HTMLElement ?? (class {} as typeof HTMLElement);

class MonadResearchDesk extends HTMLElementBase {
  monadWorkplaceExperience?: WorkplaceExperienceHostApiV1;
  #reactRoot: Root | null = null;
  #mount: HTMLDivElement | null = null;
  #unbind: (() => void) | null = null;

  connectedCallback() {
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    if (!this.#mount) {
      const style = document.createElement('style');
      style.textContent = CLIENT_STYLES;
      const mount = document.createElement('div');
      mount.style.height = '100%';
      this.#mount = mount;
      shadow.append(style, mount);
      this.#reactRoot = createRoot(mount);
    }
    this.#unbind ??= bindWorkplaceExperience(this, (host) => {
      this.monadWorkplaceExperience = host;
      this.#render();
    });
    this.#render();
  }

  disconnectedCallback() {
    this.#unbind?.();
    this.#unbind = null;
  }

  #render() {
    if (!this.#reactRoot || !this.monadWorkplaceExperience) return;
    this.dataset.projectId = this.monadWorkplaceExperience.snapshot.projectId ?? '';
    this.dataset.ready = 'true';
    this.#reactRoot.render(<ResearchDeskApp host={this.monadWorkplaceExperience} />);
  }
}

if (globalThis.customElements && !globalThis.customElements.get('monad-research-desk')) {
  globalThis.customElements.define('monad-research-desk', MonadResearchDesk as CustomElementConstructor);
}
