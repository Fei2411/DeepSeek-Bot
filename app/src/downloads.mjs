// A file the main window downloads asks where it should go first. Downloads from
// any other contents (the sign-in child, a Bot browser guest) keep their own
// session's rules.
import { join } from 'node:path'

export function downloadSaver({ window, dialog, downloads }) {
  return (event, item, source) => {
    if (source !== window.webContents) return
    const file = dialog.showSaveDialogSync(window, { defaultPath: join(downloads, item.getFilename()) })
    if (file === undefined) event.preventDefault()
    else item.setSavePath(file)
  }
}
