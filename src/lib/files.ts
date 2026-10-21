/** Saves text as a file: the share sheet where there is one (phones), otherwise a download. */
export async function saveTextFile(name: string, text: string, type = "text/plain") {
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: name }).catch(() => undefined);
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Lets the user pick files; resolves with what they chose (empty when they cancel). */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}
