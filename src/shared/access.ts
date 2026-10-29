// YouTube site access. Firefox asks for it at install, but users can turn it
// off later in about:addons (and temporary installs never ask), which silently
// stops every content script. Extension pages check it and offer a fix.

export const YT_ACCESS: browser.permissions.Permissions = { origins: ['https://www.youtube.com/*'] };

export function hasYouTubeAccess(): Promise<boolean> {
  return browser.permissions.contains(YT_ACCESS);
}

/** Must be called directly from a click handler (Firefox needs the user gesture). */
export function requestYouTubeAccess(): Promise<boolean> {
  return browser.permissions.request(YT_ACCESS);
}

/**
 * Shows `box` while access is missing; its button asks for access. YouTube
 * tabs must be reloaded afterwards for the content scripts to start.
 */
export async function wireAccessPrompt(box: HTMLElement, button: HTMLButtonElement, onGranted: () => void): Promise<void> {
  const update = async () => {
    box.hidden = await hasYouTubeAccess();
  };
  button.addEventListener('click', () => {
    void requestYouTubeAccess().then(async (granted) => {
      await update();
      if (granted) onGranted();
    });
  });
  browser.permissions.onAdded.addListener(() => void update());
  browser.permissions.onRemoved.addListener(() => void update());
  await update();
}
