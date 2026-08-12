import type { MeshRawEventRecord } from '@monad/protocol';

import { expect, type Page, test } from '@playwright/test';

import { multiTurnObservationFixtureSchema } from '../../../../packages/atoms/src/agent-adapters/observation-fixture.ts';
import claudeCodeFixtureValue from '../../../../packages/atoms/test/fixtures/mesh-agent-observation/claude-code-multi-turn.raw.json' with {
  type: 'json'
};
import codexFixtureValue from '../../../../packages/atoms/test/fixtures/mesh-agent-observation/codex-multi-turn.raw.json' with {
  type: 'json'
};

const HARNESS = '/test/e2e/fixtures/observation-panel.html';

const fixtureTest = test;

const fixtureByProvider = {
  codex: multiTurnObservationFixtureSchema.parse(codexFixtureValue),
  'claude-code': multiTurnObservationFixtureSchema.parse(claudeCodeFixtureValue)
};

type FixtureProvider = keyof typeof fixtureByProvider;

test('tool activities stay collapsed until their summary is opened', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${HARNESS}?mode=tool`);

  const cards = page.locator('[data-slot="observation-tool-card"]');
  await expect(cards).toHaveCount(3);
  const fileCard = cards.filter({ hasText: 'ObservationCard.tsx' });
  const fileSummary = fileCard.locator('summary');
  const fileTitle = fileSummary.locator('[data-slot="file-read-card-title-path"]');
  await expect(fileTitle).toHaveText('ObservationCard.tsx');
  const restingTitleColor = await fileTitle.evaluate((element) => getComputedStyle(element).color);
  await fileSummary.hover();
  await expect.poll(() => fileTitle.evaluate((element) => getComputedStyle(element).color)).not.toBe(restingTitleColor);

  await fileSummary.click();
  const scrollShadow = fileCard.locator('[data-slot="scroll-shadow"]');
  await expect(fileCard.locator('[data-slot="compact-file-path-filename"]')).toHaveText('ObservationCard.tsx');
  await expect(scrollShadow).toHaveAttribute('data-bottom-scroll', '');
  await expect(scrollShadow).not.toHaveAttribute('data-top-scroll');
  await scrollShadow.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(scrollShadow).toHaveAttribute('data-top-scroll', '');
  await expect(scrollShadow).not.toHaveAttribute('data-bottom-scroll');

  const pathSection = fileCard.locator('[data-file-read-copy-target="path"]');
  const contentSection = fileCard.locator('[data-slot="code-block-content"]');
  const pathCopyButton = fileCard.locator('[data-copy-target="path"]');
  const contentCopyButton = fileCard.locator('[data-copy-target="content"]');
  const pathCopyOverlay = pathSection.locator('[data-slot="code-block-copy-overlay"]');
  const contentCopyOverlay = contentSection.locator('[data-slot="code-block-copy-overlay"]');
  await expect.poll(() => pathCopyOverlay.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
  await expect.poll(() => contentCopyOverlay.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
  await pathSection.hover();
  await expect.poll(() => pathCopyOverlay.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
  await pathCopyButton.click();
  await expect(pathCopyButton).toHaveAttribute('data-copied', 'true');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `/workspace/${Array.from({ length: 16 }, (_, index) => `directory-segment-${index + 1}`).join('/')}/ObservationCard.tsx`
  );

  await pathCopyButton.evaluate((element) => element.blur());
  await contentSection.hover();
  await expect.poll(() => pathCopyOverlay.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
  await expect.poll(() => contentCopyOverlay.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
  await contentCopyButton.click();
  await expect(contentCopyButton).toHaveAttribute('data-copied', 'true');
  expect((await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n')).toBe(
    Array.from({ length: 32 }, (_, index) => `export const observationLine${index + 1} = ${index + 1};`).join('\n')
  );
  const commandCard = cards.filter({
    hasText: 'grep -rln "WorkplaceProjectMemberSettings" packages/protocol/src | head'
  });
  await expect(commandCard).toHaveCount(1);
  await expect(commandCard).not.toHaveAttribute('open', '');
  await expect(commandCard.getByText('1 match in card-shell.tsx', { exact: true })).toBeHidden();

  await commandCard.locator('summary').click();

  await expect(commandCard).toHaveAttribute('open', '');
  const shellCard = commandCard.locator('[data-slot="shell-tool-card"]');
  await expect(shellCard).toBeVisible();
  await expect(commandCard.getByText('1 match in card-shell.tsx', { exact: true })).toBeVisible();

  const commandCopyButton = shellCard
    .locator('[data-shell-copy-target="command"]')
    .getByRole('button', { name: 'Copy command' });
  const commandSection = shellCard.locator('[data-shell-copy-target="command"]');
  const outputSection = shellCard.locator('[data-shell-copy-target="output"]');
  const outputCopyButton = outputSection.getByRole('button', { name: 'Copy output' });
  const commandCopyOverlay = commandSection.locator('[data-slot="code-block-copy-overlay"]');
  const outputCopyOverlay = outputSection.locator('[data-slot="code-block-copy-overlay"]');
  await page.mouse.move(0, 0);
  await expect.poll(() => commandCopyOverlay.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
  await expect.poll(() => outputCopyOverlay.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
  await commandSection.hover();
  await expect.poll(() => commandCopyOverlay.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
  await commandCopyButton.click();
  await expect(commandCopyButton).toHaveAttribute('data-copied', 'true');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'grep -rln "WorkplaceProjectMemberSettings" packages/protocol/src | head'
  );
  await commandCopyButton.evaluate((element) => element.blur());
  await outputSection.hover();
  await expect.poll(() => commandCopyOverlay.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
  await expect.poll(() => outputCopyOverlay.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
  await outputCopyButton.click();
  await expect(outputCopyButton).toHaveAttribute('data-copied', 'true');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('1 match in card-shell.tsx');
});

test('Claude Read cards separate tab-delimited provider line numbers from highlighted source', async ({ page }) => {
  await page.goto(`${HARNESS}?mode=tool&provider=claude-code`);

  const fileCard = page.locator('[data-slot="observation-tool-card"]').filter({ hasText: 'ObservationCard.tsx' });
  await fileCard.locator('summary').click();
  const codeBlock = fileCard.locator('[data-generated-line-numbers]');
  await expect(codeBlock).toHaveAttribute('data-generated-line-numbers', 'false');
  await expect(codeBlock).toHaveAttribute('data-provider-line-numbers', 'true');
  const firstLine = await codeBlock
    .locator('code > span')
    .first()
    .evaluate((line) => ({
      gutter: line.querySelector('[data-slot="code-block-line-number"]')?.textContent,
      source: [...line.children]
        .filter((child) => child.getAttribute('data-slot') !== 'code-block-line-number')
        .map((child) => child.textContent)
        .join('')
    }));
  expect(firstLine).toEqual({ gutter: '11', source: 'export const observationLine1 = 1;' });
  await expect(codeBlock).not.toContainText('Provider metadata outside the file body.');
});

type FixtureExpectation = {
  firstTurnMarkerRecordIndex: number;
  newestTurnMarkerRecordIndex: number;
  splitTurnIndex: number;
  splitAtTurnRecordIndex: number;
  splitMarkerRecordIndexes: readonly number[];
};

const fixtureExpectations = {
  codex: {
    firstTurnMarkerRecordIndex: 1,
    newestTurnMarkerRecordIndex: 1,
    splitTurnIndex: 2,
    splitAtTurnRecordIndex: 56,
    splitMarkerRecordIndexes: [1, 55, 56, 110]
  },
  'claude-code': {
    firstTurnMarkerRecordIndex: 3,
    newestTurnMarkerRecordIndex: 26,
    splitTurnIndex: 4,
    splitAtTurnRecordIndex: 30,
    splitMarkerRecordIndexes: [22, 29, 30, 38]
  }
} as const satisfies Record<FixtureProvider, FixtureExpectation>;

type FixturePage = {
  cursor: `provider:fixture-page-${number}`;
  end: number;
  records: MeshRawEventRecord[];
  start: number;
};

type FixturePageSet = {
  expectedSplitMarkerIdentities: string[];
  pages: FixturePage[];
  splitTurnIndex: number;
};

function fixtureMarkerData(provider: FixtureProvider, markerIdentity: string): Record<string, unknown> {
  if (provider === 'codex') {
    return {
      type: 'item.completed',
      item: { id: markerIdentity, type: 'agent_message', text: markerIdentity }
    };
  }
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: markerIdentity }] },
    uuid: markerIdentity
  };
}

function fixturePages(provider: FixtureProvider): FixturePageSet {
  const fixture = fixtureByProvider[provider];
  const expectation = fixtureExpectations[provider];
  const offsets = [0];
  for (const turn of fixture.turns) offsets.push((offsets.at(-1) ?? 0) + turn.records.length);
  const middleTurnIndex = expectation.splitTurnIndex;
  const middleTurnStart = offsets[middleTurnIndex] ?? 0;
  const middleTurnEnd = offsets[middleTurnIndex + 1] ?? middleTurnStart;
  const splitTurnRecordIndexes = [...expectation.splitMarkerRecordIndexes];
  const splitAtTurnRecordIndex = expectation.splitAtTurnRecordIndex;
  const split = middleTurnStart + splitAtTurnRecordIndex;
  const firstTurnEnd = offsets[1] ?? 0;
  const records = fixture.turns.flatMap((turn, turnIndex) =>
    turn.records.map((record, turnRecordIndex) => ({
      record,
      recordIndex: (offsets[turnIndex] ?? 0) + turnRecordIndex,
      turnIndex,
      turnRecordIndex
    }))
  );
  const markerIndexesByTurn: Array<readonly [number, number[]]> = [
    [0, [expectation.firstTurnMarkerRecordIndex]],
    [middleTurnIndex, splitTurnRecordIndexes],
    [fixture.turns.length - 1, [expectation.newestTurnMarkerRecordIndex]]
  ];
  const markers: Array<{
    half: number;
    markerCount: number;
    markerOrdinal: number;
    recordIndex: number;
    turnIndex: number;
    turnRecordIndex: number;
  }> = [];
  for (const [turnIndex, turnRecordIndexes] of markerIndexesByTurn) {
    for (const [markerOrdinal, turnRecordIndex] of turnRecordIndexes.entries()) {
      markers.push({
        half: turnIndex === middleTurnIndex && turnRecordIndex >= splitAtTurnRecordIndex ? 1 : 0,
        markerCount: turnRecordIndexes.length,
        markerOrdinal,
        recordIndex: (offsets[turnIndex] ?? 0) + turnRecordIndex,
        turnIndex,
        turnRecordIndex
      });
    }
  }
  const ranges = [
    [split, records.length],
    [firstTurnEnd, split],
    [0, firstTurnEnd]
  ] as const;
  if (!(middleTurnStart < split && split < middleTurnEnd)) {
    throw new Error(`fixture page boundary does not split a middle turn for ${provider}`);
  }
  return {
    expectedSplitMarkerIdentities: splitTurnRecordIndexes.map(
      (turnRecordIndex, markerOrdinal) =>
        `fixture-marker-t${middleTurnIndex}-o${markerOrdinal}-n${splitTurnRecordIndexes.length}-h${turnRecordIndex >= splitAtTurnRecordIndex ? 1 : 0}-r${turnRecordIndex}`
    ),
    pages: ranges.map(([start, end], pageIndex) => ({
      cursor: `provider:fixture-page-${pageIndex}`,
      end,
      start,
      records: records.slice(start, end).flatMap(({ record, recordIndex }) => {
        const identity = `fixture-${provider}-record-${recordIndex}`;
        const fixtureRecord = { ...record, cursor: `provider:${identity}`, providerIdentity: identity };
        const marker = markers.find((candidate) => candidate.recordIndex === recordIndex);
        if (!marker) return [fixtureRecord];
        const markerIdentity = `fixture-marker-t${marker.turnIndex}-o${marker.markerOrdinal}-n${marker.markerCount}-h${marker.half}-r${marker.turnRecordIndex}`;
        return [
          fixtureRecord,
          {
            cursor: `provider:${markerIdentity}`,
            data: fixtureMarkerData(provider, markerIdentity),
            providerIdentity: markerIdentity
          }
        ];
      })
    })),
    splitTurnIndex: middleTurnIndex
  };
}

function fixtureRequestCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    (
      window.observationHarness as typeof window.observationHarness & {
        fixtureRequestCount: () => number;
      }
    ).fixtureRequestCount()
  );
}

function safeDiagnosticName(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.exec(value)?.[0] === value ? value : 'UnknownError';
}

type ObservationState = {
  distanceFromBottom: number;
  loadCount: number;
  loadedTopRowOffset: number | null;
  loadingHeader: boolean;
  rowCount: number;
  bottomBodyText: string | null;
  scrollTop: number;
  topVisibleRowId: string | null;
};

function state(page: Page): Promise<ObservationState> {
  return page.evaluate(() => window.observationHarness.state());
}

async function openHarness(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await page.goto(HARNESS);
  await page
    .locator('[role="log"] [data-index]')
    .first()
    .waitFor({ timeout: 5000 })
    .catch((error: unknown) => {
      if (errors.length > 0) throw new Error(errors.join('\n\n'));
      throw error;
    });
}

type VirtualizedOccurrence = {
  renderedElementIndex: number;
  renderedItemIndex: number;
  safeIdentity: string;
};

async function waitForRenderFrames(page: Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function collectVirtualizedOccurrences(
  page: Page,
  selector: string,
  read: 'aria-label' | 'data-raw-card-id' | 'text-content'
): Promise<VirtualizedOccurrence[]> {
  return page.locator('[role="log"]').evaluate(
    async (scroller, args) => {
      const occurrences: VirtualizedOccurrence[] = [];
      const collect = () => {
        for (const row of scroller.querySelectorAll<HTMLElement>('[data-index]')) {
          const renderedItemIndex = Number.parseInt(row.dataset.index ?? '', 10);
          if (!Number.isInteger(renderedItemIndex)) continue;
          for (const [renderedElementIndex, element] of [
            ...row.querySelectorAll<HTMLElement>(args.selector)
          ].entries()) {
            const safeIdentity = args.read === 'text-content' ? element.textContent : element.getAttribute(args.read);
            if (!safeIdentity) continue;
            const alreadyObserved = occurrences.some(
              (occurrence) =>
                occurrence.renderedItemIndex === renderedItemIndex &&
                occurrence.renderedElementIndex === renderedElementIndex &&
                occurrence.safeIdentity === safeIdentity
            );
            if (!alreadyObserved) occurrences.push({ renderedElementIndex, renderedItemIndex, safeIdentity });
          }
        }
      };
      const settle = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const step = Math.max(1, Math.floor(scroller.clientHeight * 0.7));
      for (let offset = 0; offset < scroller.scrollHeight; offset += step) {
        scroller.scrollTop = offset;
        scroller.dispatchEvent(new Event('scroll'));
        await settle();
        collect();
      }
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll'));
      await settle();
      collect();
      return occurrences.sort(
        (left, right) =>
          left.renderedItemIndex - right.renderedItemIndex || left.renderedElementIndex - right.renderedElementIndex
      );
    },
    { read, selector }
  );
}

type RenderedFixtureIntegrity = {
  firstFixtureTurnIndex: number;
  newestFixtureTurnIndex: number;
  splitExpectedMarkerCount: number;
  splitOccurrences: Array<{ renderedItemIndex: number; safeIdentity: string; textPosition: number }>;
  splitMarkersOrdered: boolean;
  splitMarkersUnique: boolean;
  splitRenderedMarkerCount: number;
  splitSpansBothHalves: boolean;
  turnHeadingsPresent: boolean;
};

async function renderedFixtureIntegrity(
  page: Page,
  args: {
    mode: 'all' | 'newest';
    splitExpectedMarkerCount: number;
    splitTurnIndex: number;
    totalTurnCount: number;
  }
): Promise<RenderedFixtureIntegrity> {
  return page.locator('[role="log"]').evaluate(async (scroller, options) => {
    const markers: Array<{
      fixtureTurnIndex: number;
      half: number;
      itemIndex: number;
      markerCount: number;
      markerOrdinal: number;
      safeIdentity: string;
      textPosition: number;
      turnRecordIndex: number;
    }> = [];
    const markerPattern = /fixture-marker-t(\d+)-o(\d+)-n(\d+)-h(\d+)-r(\d+)/g;
    const collect = () => {
      for (const row of scroller.querySelectorAll<HTMLElement>('[data-index]')) {
        const itemIndex = Number.parseInt(row.dataset.index ?? '', 10);
        if (!Number.isInteger(itemIndex)) continue;
        for (const match of row.textContent?.matchAll(markerPattern) ?? []) {
          const [identity, fixtureTurnIndex, markerOrdinal, markerCount, half, turnRecordIndex] = match;
          if (
            !identity ||
            fixtureTurnIndex === undefined ||
            markerOrdinal === undefined ||
            markerCount === undefined ||
            half === undefined ||
            turnRecordIndex === undefined
          )
            continue;
          const textPosition = match.index ?? 0;
          const alreadyObserved = markers.some(
            (marker) =>
              marker.safeIdentity === identity && marker.itemIndex === itemIndex && marker.textPosition === textPosition
          );
          if (alreadyObserved) continue;
          markers.push({
            fixtureTurnIndex: Number.parseInt(fixtureTurnIndex, 10),
            half: Number.parseInt(half, 10),
            itemIndex,
            markerCount: Number.parseInt(markerCount, 10),
            markerOrdinal: Number.parseInt(markerOrdinal, 10),
            safeIdentity: identity,
            textPosition,
            turnRecordIndex: Number.parseInt(turnRecordIndex, 10)
          });
        }
      }
    };
    const settle = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const step = Math.max(1, Math.floor(scroller.clientHeight * 0.7));
    if (options.mode === 'newest') {
      for (let offset = scroller.scrollHeight; offset >= 241; offset -= step) {
        scroller.scrollTop = offset;
        scroller.dispatchEvent(new Event('scroll'));
        await settle();
        collect();
        const newestMarker = markers.find((marker) => marker.fixtureTurnIndex === options.totalTurnCount - 1);
        if (newestMarker) break;
      }
    } else {
      for (let offset = 0; offset < scroller.scrollHeight; offset += step) {
        scroller.scrollTop = offset;
        scroller.dispatchEvent(new Event('scroll'));
        await settle();
        collect();
      }
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll'));
      await settle();
      collect();
    }
    const firstMarkers = markers.filter((marker) => marker.fixtureTurnIndex === 0);
    const newestFixtureTurnIndex = options.totalTurnCount - 1;
    const newestMarkers = markers.filter((marker) => marker.fixtureTurnIndex === newestFixtureTurnIndex);
    const splitMarkers = markers
      .filter((marker) => marker.fixtureTurnIndex === options.splitTurnIndex)
      .sort(
        (left, right) =>
          left.itemIndex - right.itemIndex ||
          left.textPosition - right.textPosition ||
          left.turnRecordIndex - right.turnRecordIndex
      );
    return {
      firstFixtureTurnIndex: firstMarkers.length > 0 ? 0 : -1,
      newestFixtureTurnIndex: newestMarkers.length > 0 ? newestFixtureTurnIndex : -1,
      splitExpectedMarkerCount: options.splitExpectedMarkerCount,
      splitOccurrences: splitMarkers.map((marker) => ({
        renderedItemIndex: marker.itemIndex,
        safeIdentity: marker.safeIdentity,
        textPosition: marker.textPosition
      })),
      splitMarkersOrdered: splitMarkers.every((marker, index) => marker.markerOrdinal === index),
      splitMarkersUnique: splitMarkers.every(
        (marker, index) =>
          splitMarkers.findIndex((candidate) => candidate.safeIdentity === marker.safeIdentity) === index
      ),
      splitRenderedMarkerCount: splitMarkers.length,
      splitSpansBothHalves:
        splitMarkers.some((marker) => marker.half === 0) && splitMarkers.some((marker) => marker.half === 1),
      turnHeadingsPresent: scroller.querySelector('[data-observation-turn-heading="true"]') !== null
    };
  }, args);
}

function registerFixturePagingTests(): void {
  fixtureTest.describe('fixture-backed observation paging', () => {
    for (const provider of ['codex', 'claude-code'] as const) {
      fixtureTest(
        `${provider} fixture pages through the real observation rail without duplicate records or turns`,
        async ({ page }) => {
          const fixture = fixtureByProvider[provider];
          const { expectedSplitMarkerIdentities, pages, splitTurnIndex } = fixturePages(provider);
          const splitExpectedMarkerCount = expectedSplitMarkerIdentities.length;
          const rawRequests: string[] = [];
          let diagnosticStep = 'install-route';
          const runStep = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
            diagnosticStep = name;
            return fixtureTest.step(name, operation);
          };
          try {
            await runStep('install-route', async () => {
              await page.route('**/v1/mesh/sessions/*/events/raw?*', async (route) => {
                const cursor = new URL(route.request().url()).searchParams.get('before') ?? 'missing';
                rawRequests.push(cursor);
                const pageIndex = pages.findIndex((candidate) => candidate.cursor === cursor);
                if (pageIndex < 0) {
                  await route.fulfill({ json: { error: 'unknown fixture cursor', provider }, status: 400 });
                  return;
                }
                const fixturePage = pages[pageIndex];
                if (!fixturePage) throw new Error(`missing fixture page ${pageIndex} for ${provider}`);
                await route.fulfill({
                  json: {
                    records: fixturePage.records,
                    coverage: fixture.turns[0]?.coverage ?? 'settled',
                    ...(pages[pageIndex + 1] ? { nextCursor: pages[pageIndex + 1]?.cursor } : {})
                  }
                });
              });
            });

            await runStep('load-newest-turn', async () => {
              await page.goto(`${HARNESS}?mode=fixture&provider=${provider}`);
              await expect.poll(() => rawRequests.length).toBeGreaterThanOrEqual(1);
              await expect.poll(async () => fixtureRequestCount(page)).toBeGreaterThan(0);
              await waitForRenderFrames(page);
              expect(rawRequests.every((cursor) => cursor === pages[0]?.cursor)).toBe(true);
              const initial = await renderedFixtureIntegrity(page, {
                mode: 'newest',
                splitExpectedMarkerCount,
                splitTurnIndex,
                totalTurnCount: fixture.turns.length
              });
              expect({
                newestFixtureTurnIndex: initial.newestFixtureTurnIndex,
                turnHeadingsPresent: initial.turnHeadingsPresent
              }).toEqual({
                newestFixtureTurnIndex: fixture.turns.length - 1,
                turnHeadingsPresent: false
              });
            });

            await runStep('load-middle-page-once', async () => {
              const beforeRequestCount = await fixtureRequestCount(page);
              const beforeRawRequestCount = rawRequests.length;
              await page.getByRole('button', { name: 'Scroll to top' }).click();
              await expect.poll(async () => fixtureRequestCount(page)).toBe(beforeRequestCount + 1);
              await expect.poll(() => rawRequests.length).toBe(beforeRawRequestCount + 1);
              await waitForRenderFrames(page);
              expect({
                convenienceRequestCount: await fixtureRequestCount(page),
                rawRequestCount: rawRequests.length
              }).toEqual({
                convenienceRequestCount: beforeRequestCount + 1,
                rawRequestCount: beforeRawRequestCount + 1
              });
            });

            await runStep('load-oldest-turn-once', async () => {
              const beforeRequestCount = await fixtureRequestCount(page);
              const beforeRawRequestCount = rawRequests.length;
              await page.getByRole('button', { name: 'Scroll to top' }).click();
              await expect.poll(async () => fixtureRequestCount(page)).toBe(beforeRequestCount + 1);
              await expect.poll(() => rawRequests.length).toBe(beforeRawRequestCount + 1);
              await expect(page.locator('[data-events-state="start"]')).toHaveCount(1);
              await waitForRenderFrames(page);
              expect({
                convenienceRequestCount: await fixtureRequestCount(page),
                rawRequestCount: rawRequests.length
              }).toEqual({
                convenienceRequestCount: beforeRequestCount + 1,
                rawRequestCount: beforeRawRequestCount + 1
              });
            });

            await runStep('verify-projected-turn-integrity', async () => {
              const rendered = await renderedFixtureIntegrity(page, {
                mode: 'all',
                splitExpectedMarkerCount,
                splitTurnIndex,
                totalTurnCount: fixture.turns.length
              });
              const splitLocationsUnique = rendered.splitOccurrences.every(
                (occurrence, index) =>
                  rendered.splitOccurrences.findIndex(
                    (candidate) =>
                      candidate.renderedItemIndex === occurrence.renderedItemIndex &&
                      candidate.textPosition === occurrence.textPosition
                  ) === index
              );
              expect({
                firstFixtureTurnIndex: rendered.firstFixtureTurnIndex,
                newestFixtureTurnIndex: rendered.newestFixtureTurnIndex,
                splitExpectedMarkerCount: rendered.splitExpectedMarkerCount,
                splitOccurrenceIdentities: rendered.splitOccurrences.map((occurrence) => occurrence.safeIdentity),
                splitOccurrenceLocationCount: rendered.splitOccurrences.length,
                splitOccurrenceLocationsUnique: splitLocationsUnique,
                splitMarkersOrdered: rendered.splitMarkersOrdered,
                splitMarkersUnique: rendered.splitMarkersUnique,
                splitRenderedMarkerCount: rendered.splitRenderedMarkerCount,
                splitSpansBothHalves: rendered.splitSpansBothHalves,
                turnHeadingsPresent: rendered.turnHeadingsPresent
              }).toEqual({
                firstFixtureTurnIndex: 0,
                newestFixtureTurnIndex: fixture.turns.length - 1,
                splitExpectedMarkerCount,
                splitOccurrenceIdentities: expectedSplitMarkerIdentities,
                splitOccurrenceLocationCount: splitExpectedMarkerCount,
                splitOccurrenceLocationsUnique: true,
                splitMarkersOrdered: true,
                splitMarkersUnique: true,
                splitRenderedMarkerCount: splitExpectedMarkerCount,
                splitSpansBothHalves: true,
                turnHeadingsPresent: false
              });
            });

            const newestRecordId = `fixture-${provider}-record-${pages[0]?.end ? pages[0].end - 1 : 0}`;
            await runStep('open-raw-newest-page', async () => {
              const beforeRawRequestCount = rawRequests.length;
              await page.getByRole('tab', { name: 'Raw' }).click();
              await expect.poll(() => rawRequests.length).toBe(beforeRawRequestCount + 1);
              await expect(page.locator(`[data-raw-card-id="${newestRecordId}"]`)).toHaveCount(1);
            });

            await runStep('load-raw-middle-page-once', async () => {
              const beforeRawRequestCount = rawRequests.length;
              await page.getByRole('button', { name: 'Scroll to top' }).click();
              await expect.poll(() => rawRequests.length).toBe(beforeRawRequestCount + 1);
              await waitForRenderFrames(page);
              expect(rawRequests.length).toBe(beforeRawRequestCount + 1);
            });

            await runStep('load-raw-oldest-page-once', async () => {
              const beforeRawRequestCount = rawRequests.length;
              await page.getByRole('button', { name: 'Scroll to top' }).click();
              await expect.poll(() => rawRequests.length).toBe(beforeRawRequestCount + 1);
              await expect(page.locator('[data-events-state="start"]')).toHaveCount(1);
              await waitForRenderFrames(page);
              expect(rawRequests.length).toBe(beforeRawRequestCount + 1);
            });

            await runStep('verify-raw-record-integrity', async () => {
              const rawOccurrences = (
                await collectVirtualizedOccurrences(page, '[data-raw-card-id]', 'data-raw-card-id')
              ).filter(
                (occurrence) =>
                  /^fixture-(?:codex|claude-code)-record-\d+$/.exec(occurrence.safeIdentity)?.[0] ===
                  occurrence.safeIdentity
              );
              const rawIdentities = rawOccurrences.map((occurrence) => occurrence.safeIdentity);
              const firstRecordId = `fixture-${provider}-record-0`;
              const totalRecordCount = fixture.turns.reduce((count, turn) => count + turn.records.length, 0);
              const expectedRawIdentities = Array.from(
                { length: totalRecordCount },
                (_, recordIndex) => `fixture-${provider}-record-${recordIndex}`
              );
              expect({ firstRecordId, newestRecordId, rawIdentities }).toEqual({
                firstRecordId: expectedRawIdentities[0],
                newestRecordId: expectedRawIdentities.at(-1),
                rawIdentities: expectedRawIdentities
              });
            });

            await runStep('repeat-mode-switches-preserve-loaded-planes', async () => {
              const convenienceRequestCount = await fixtureRequestCount(page);
              const rawRequestCount = rawRequests.length;
              for (let cycle = 0; cycle < 2; cycle += 1) {
                await page.getByRole('tab', { name: 'Activity' }).click();
                const rendered = await renderedFixtureIntegrity(page, {
                  mode: 'all',
                  splitExpectedMarkerCount,
                  splitTurnIndex,
                  totalTurnCount: fixture.turns.length
                });
                expect({
                  firstFixtureTurnIndex: rendered.firstFixtureTurnIndex,
                  newestFixtureTurnIndex: rendered.newestFixtureTurnIndex
                }).toEqual({
                  firstFixtureTurnIndex: 0,
                  newestFixtureTurnIndex: fixture.turns.length - 1
                });

                await page.getByRole('tab', { name: 'Raw' }).click();
                await expect(page.locator(`[data-raw-card-id="${newestRecordId}"]`)).toHaveCount(1);
              }
              expect({
                convenienceRequestCount: await fixtureRequestCount(page),
                rawRequestCount: rawRequests.length
              }).toEqual({ convenienceRequestCount, rawRequestCount });
            });
          } catch (error) {
            const unsafeCategory = error instanceof Error ? error.constructor.name : typeof error;
            const unsafeName = error instanceof Error ? error.name : typeof error;
            const errorCategory = safeDiagnosticName(unsafeCategory);
            const errorName = safeDiagnosticName(unsafeName);
            await page.goto('about:blank').catch(() => {});
            const diagnostic = new Error(
              `${provider} fixture panel paging failed; category=${errorCategory}; name=${errorName}; step=${diagnosticStep}; location=fixture-matrix/${diagnosticStep}; rawRequestCount=${rawRequests.length}; cursors=${rawRequests.join(',')}`
            );
            diagnostic.name = `FixtureMatrix${errorName}`;
            throw diagnostic;
          }
        }
      );
    }
  });
}

test('the raw list paints a card body verbatim in the real browser', async ({ page }) => {
  await openHarness(page);

  // The SSR/pure-function unit tests cannot see a VirtualList row (rows only mount client-side).
  // Here the real list is scrolled to its newest frame, so the bottom card's preformatted body must
  // be present and carry its provider payload text.
  const current = await state(page);
  expect(current.rowCount).toBeGreaterThan(0);
  expect(current.bottomBodyText ?? '').toContain('Provider-native raw frame body');
});

test('the panel Scroll to top button loads one page, holds the anchor below the start zone, and does not chain', async ({
  page
}) => {
  await openHarness(page);
  expect(await state(page).then((s) => s.loadCount)).toBe(0);

  // Clicking the panel's own button must reach the list's VirtualList scroll control via
  // contentControlRef and fire onLoadOlderEvents once — not zero (forwarding dropped) and not twice
  // (a second trigger source). This is the panel-forwarding + raw-spread wiring the unit tests mask.
  await page.getByRole('button', { name: 'Scroll to top' }).click();
  await expect.poll(async () => (await state(page)).loadingHeader).toBe(true);
  await expect.poll(async () => (await state(page)).loadCount).toBe(1);
  await expect.poll(async () => (await state(page)).loadingHeader).toBe(false);
  // The five older rows were inserted above the previously loaded first row. TanStack's keyed end
  // anchor keeps that row at the same viewport offset and moves the scroller clear of the load zone.
  await expect
    .poll(async () => {
      const after = await state(page);
      return {
        anchorStable: after.loadedTopRowOffset !== null && after.loadedTopRowOffset > 0,
        clearedStartZone: after.scrollTop > 240
      };
    })
    .toEqual({
      anchorStable: true,
      clearedStartZone: true
    });

  // No further gesture: the viewport now sits below the start zone, so the start edge must not
  // chain-load a second page on its own — the runaway-to-oldest bug.
  await waitForRenderFrames(page, 12);
  expect(await state(page).then((s) => s.loadCount)).toBe(1);
});

test('the loading header is shown while an older page is being fetched', async ({ page }) => {
  await openHarness(page);

  await page.getByRole('button', { name: 'Scroll to top' }).click();
  await expect(page.locator('[data-events-state="loading"]')).toBeVisible();
  await expect.poll(async () => (await state(page)).loadCount).toBe(1);
});

test('a fast scrollbar jump to the loaded top starts loading without a second nudge', async ({ page }) => {
  await openHarness(page);
  expect(await state(page).then((s) => s.loadCount)).toBe(0);

  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[role="log"]');
    if (!scroller) return;
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
  });

  await expect.poll(async () => (await state(page)).loadingHeader).toBe(true);
  await expect.poll(async () => (await state(page)).loadCount).toBe(1);
});

test('the timeline renders turn activity without index rows or collapse controls', async ({ page }) => {
  await page.goto(`${HARNESS}?mode=turn`);
  await expect(page.getByText(/^Turn Index:/)).toHaveCount(0);
  await expect(
    page.locator('[aria-label="Group activity by turn"], [aria-label="Show individual activity"]')
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Collapse all activity' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Expand all activity' })).toHaveCount(0);
  await expect(page.getByText('agent-a turn 16', { exact: false })).toBeVisible();

  await expect.poll(async () => (await state(page)).distanceFromBottom).toBe(0);

  await page.getByRole('button', { name: 'Scroll to top' }).click();
  await expect.poll(async () => (await state(page)).loadingHeader).toBe(true);
  await expect.poll(async () => (await state(page)).loadCount).toBe(1);
});

test('switching observed agents resets the inline turn timeline to the latest turn', async ({ page }) => {
  await page.goto(`${HARNESS}?mode=turn`);
  await expect(page.locator('[role="log"]')).toContainText('agent-a turn');
  await expect(page.getByText(/^Turn Index:/)).toHaveCount(0);
  await expect.poll(async () => (await state(page)).distanceFromBottom).toBe(0);

  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[role="log"]');
    if (!scroller) return;
    scroller.scrollTop = Math.max(0, scroller.scrollHeight / 2 - scroller.clientHeight / 2);
    scroller.dispatchEvent(new Event('scroll'));
  });
  expect(await state(page).then((s) => s.distanceFromBottom)).toBeGreaterThan(0);

  await page.evaluate(() => window.observationHarness.agent('agent-b'));
  await expect(page.locator('[role="log"]')).toContainText('agent-b turn');
  await expect.poll(async () => (await state(page)).distanceFromBottom).toBe(0);
});

test('Codex session context usage opens from the circular progress control and closes accessibly', async ({ page }) => {
  await page.goto(`${HARNESS}?mode=fixture&provider=codex`);

  const trigger = page.getByRole('button', { name: 'Show session usage' });
  await expect(trigger).toBeVisible();
  await expect(trigger.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '28');

  await trigger.click();
  const details = page.getByRole('dialog', { name: 'Session usage' });
  await expect(details).toBeVisible();
  await expect(details).toContainText('72.7K / 258.4K');
  await expect(details).toContainText('28%');
  await expect(details).toContainText('597,658');
  await expect(details).toContainText('2,768');
  await expect(details).toContainText('600,426');
  await expect(details).toContainText('518,656');
  await expect(details).toContainText('845');

  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await trigger.click();
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(details).toHaveCount(0);
});

test('session usage stays hidden when the adapter does not expose a context window', async ({ page }) => {
  await page.goto(`${HARNESS}?mode=fixture&provider=claude-code`);

  await expect(page.getByRole('button', { name: 'Show session usage' })).toHaveCount(0);
});

registerFixturePagingTests();
