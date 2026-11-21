/** The bundled font files, so main.tsx can ask the service worker to cache them for offline use. Keep in step with fonts.css. */
import f_inter_400 from '../../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2?url';
import f_inter_600 from '../../node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2?url';
import f_fraunces_600 from '../../node_modules/@fontsource/fraunces/files/fraunces-latin-600-normal.woff2?url';
import f_ibm_plex_sans_400 from '../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2?url';
import f_ibm_plex_sans_600 from '../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2?url';
import f_ibm_plex_mono_400 from '../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url';
import f_ibm_plex_mono_600 from '../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2?url';
import f_nunito_400 from '../../node_modules/@fontsource/nunito/files/nunito-latin-400-normal.woff2?url';
import f_nunito_700 from '../../node_modules/@fontsource/nunito/files/nunito-latin-700-normal.woff2?url';

export const FONT_URLS: string[] = [f_inter_400, f_inter_600, f_fraunces_600, f_ibm_plex_sans_400, f_ibm_plex_sans_600, f_ibm_plex_mono_400, f_ibm_plex_mono_600, f_nunito_400, f_nunito_700];
