import React from "react";

export function Button({ label }: { label: string }) {
  return <button onClick={() => track("click")}>{label}</button>;
}
