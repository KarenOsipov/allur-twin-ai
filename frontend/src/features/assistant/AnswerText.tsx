export function AnswerText({ text }: { text: string }) {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^\s*#{1,6}\s+/, ""))
    .filter((l) => l.trim() && !/^\s*([-*_])\1{2,}\s*$/.test(l));
  return (
    <div className="flex flex-col gap-1.5 text-sm leading-relaxed">
      {lines.map((l, i) => {
        const bullet = /^\s*(•|-|\*|\d+[.)])\s+/.exec(l);
        return bullet ? (
          <div key={i} className="flex gap-2 pl-1">
            <span className="shrink-0 text-ink-3">{/^\d/.test(bullet[1]) ? bullet[1] : "•"}</span>
            <span>
              <Inline text={l.slice(bullet[0].length)} />
            </span>
          </div>
        ) : (
          <p key={i} className={i === 0 ? "font-medium" : ""}>
            <Inline text={l} />
          </p>
        );
      })}
    </div>
  );
}

export function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <strong key={i} className="font-semibold text-ink">
            {p.slice(2, -2)}
          </strong>
        ) : p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <span key={i}>{p.slice(1, -1)}</span>
        ) : (
          p
        ),
      )}
    </>
  );
}
