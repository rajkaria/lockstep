export function makeStampFooter(deps: {
  React: typeof import('react');
  Head: (props: { children?: unknown }) => unknown;
  useDoc: () => { metadata?: { source?: string } };
  usePluginData: (name: string) => { prefix?: string } | undefined;
  Original: (props: Record<string, unknown>) => unknown;
  pluginName?: string;
}): (props: Record<string, unknown>) => unknown;
export function refreshStamp(win: { StaleproofStamp?: () => unknown } | undefined): void;
export function renderStampFooter(deps: Parameters<typeof makeStampFooter>[0], props: Record<string, unknown>): unknown;
