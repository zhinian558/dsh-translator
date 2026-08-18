/**
 * Language roster of the translator window. Display names are the languages'
 * native names (locale-neutral), while `promptName` feeds the host prompt.
 */

export interface Lang {
  /** Language code used on the wire and in the prompt. */
  code: string
  /** Native display name shown in the picker. */
  name: string
  /** English name used inside the translation prompt. */
  promptName: string
}

/** The languages offered by the window; 'auto' is handled separately. */
export const LANGS: readonly Lang[] = [
  { code: 'zh-CN', name: '简体中文', promptName: 'Simplified Chinese' },
  { code: 'zh-TW', name: '繁體中文', promptName: 'Traditional Chinese' },
  { code: 'en', name: 'English', promptName: 'English' },
  { code: 'ja', name: '日本語', promptName: 'Japanese' },
  { code: 'ko', name: '한국어', promptName: 'Korean' },
  { code: 'fr', name: 'Français', promptName: 'French' },
  { code: 'de', name: 'Deutsch', promptName: 'German' },
  { code: 'es', name: 'Español', promptName: 'Spanish' },
  { code: 'ru', name: 'Русский', promptName: 'Russian' },
  { code: 'pt', name: 'Português', promptName: 'Portuguese' },
  { code: 'it', name: 'Italiano', promptName: 'Italian' },
  { code: 'ar', name: 'العربية', promptName: 'Arabic' },
  { code: 'tr', name: 'Türkçe', promptName: 'Turkish' },
  { code: 'th', name: 'ไทย', promptName: 'Thai' },
  { code: 'vi', name: 'Tiếng Việt', promptName: 'Vietnamese' },
  { code: 'id', name: 'Bahasa Indonesia', promptName: 'Indonesian' },
  { code: 'nl', name: 'Nederlands', promptName: 'Dutch' },
  { code: 'pl', name: 'Polski', promptName: 'Polish' },
  { code: 'uk', name: 'Українська', promptName: 'Ukrainian' },
  { code: 'hi', name: 'हिन्दी', promptName: 'Hindi' },
]

/** Display name of one language code, with a fallback for unknown codes. */
export function langName(code: string): string {
  const hit = LANGS.find(lang => lang.code === code)
  return hit?.name ?? code
}
