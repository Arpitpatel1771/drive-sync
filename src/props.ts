/** Helpers for the appProperties that tie a Drive file to an item: `${namespace}Kind` and `${namespace}Id`. */
export interface Props {
  kindKey: string;
  idKey: string;
  tag(kind: string, id: string): Record<string, string>;
  read(file: { appProperties?: Record<string, string> | null }): { kind?: string; id?: string };
}

export function props(namespace: string): Props {
  const kindKey = `${namespace}Kind`;
  const idKey = `${namespace}Id`;
  return {
    kindKey,
    idKey,
    tag: (kind, id) => ({ [kindKey]: kind, [idKey]: id }),
    read(file) {
      const p = file.appProperties ?? {};
      const out: { kind?: string; id?: string } = {};
      if (p[kindKey] !== undefined) out.kind = p[kindKey];
      if (p[idKey] !== undefined) out.id = p[idKey];
      return out;
    },
  };
}
