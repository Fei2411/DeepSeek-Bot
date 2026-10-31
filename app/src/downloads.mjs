// A file the main window downloads asks where it should go first. Downloads from
// any other contents (the sign-in child, a Bot browser guest) keep their own
// session's rules.
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'

/**
 * @param {{ window: any, dialog: any, getPath: (name: string) => string, homedir?: () => string }} options
 *   `getPath` is Electron's app.getPath, asked again for every download.
 */
export function downloadSaver({ window, dialog, getPath, homedir = osHomedir }) {
  return (event, item, source) => {
    // The window is asked for at the moment of the download: the app may build a new one.
    const owner = typeof window === 'function' ? window() : window
    if (owner === undefined || owner === null || source !== owner.webContents) return
    const folder = startFolder(getPath, homedir)
    const name = item.getFilename()
    const file = dialog.showSaveDialogSync(owner, { defaultPath: folder === undefined ? name : join(folder, name) })
    if (file === undefined) event.preventDefault()
    else item.setSavePath(file)
  }
}

// getPath throws when a known folder does not resolve (Downloads deleted, or redirected to a
// drive that is not there). Without any folder the dialog gets only the file name and opens
// where it likes.
function startFolder(getPath, homedir) {
  for (const find of [() => getPath('downloads'), () => getPath('home'), homedir]) {
    try {
      const folder = find()
      if (folder) return folder
    } catch {}
  }
  return undefined
}
