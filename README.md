# 🩸 Clocktower Timer

Temporizador por fases con banda sonora de **Spotify** para dirigir partidas de
**Blood on the Clocktower** desde una tablet.

- ⏱️ Cuenta atrás gigante, pensada para verse desde el otro lado de la mesa.
- 🌙☀️ Alterna noche y día: cada fase tiene su propia duración y su propia lista de Spotify.
- 📉 Progresión automática configurable: por defecto **10 min la primera ronda, −2 min por ronda, con suelo de 6 min**.
- ✍️ Cualquier ronda se puede fijar a mano (¿quieres que la noche 1 dure 20 minutos? se escribe y ya está).
- 🎚️ Fundido de volumen al cambiar de lista, aleatorio y opción de retomar cada lista donde se quedó.
- 🔊 Suena en la propia tablet (reproductor integrado) o en cualquier otro dispositivo Spotify: altavoz, móvil, PC…
- 🔔 Campanada al acabar el tiempo, aviso visual en los últimos segundos y pantalla siempre encendida.

No necesita servidor, ni instalación, ni `npm`: son ficheros estáticos (HTML + CSS + JavaScript).

---

## 1. Crear la aplicación en Spotify (una sola vez)

1. Entra en <https://developer.spotify.com/dashboard> con tu cuenta de Spotify.
2. **Create app**. Nombre y descripción, los que quieras.
3. En **Redirect URIs** añade la URL exacta desde la que vas a abrir la aplicación
   (la app te la muestra y te la copia en *Ajustes → Spotify*). Por ejemplo:
   - `https://TU-USUARIO.github.io/Bloodontheclocktower/` si la publicas en GitHub Pages;
   - `http://127.0.0.1:8080/` si la usas en local.
4. En **APIs used** marca **Web API** y **Web Playback SDK**.
5. Guarda y copia el **Client ID** (el *Client Secret* no hace falta: se usa PKCE).

> **Spotify Premium es obligatorio.** Spotify no permite controlar la reproducción
> desde otra aplicación con cuentas gratuitas.

## 2. Publicar la aplicación

### Opción A — GitHub Pages (recomendado para la tablet)

En el repositorio: **Settings → Pages → Source: GitHub Actions**. Cada push a la rama
principal publica la app en `https://TU-USUARIO.github.io/Bloodontheclocktower/`.

### Opción B — En local

```bash
python3 -m http.server 8080 --bind 127.0.0.1
# y abre http://127.0.0.1:8080/
```

Usa `127.0.0.1`, no `localhost`: Spotify solo acepta `https://` o la dirección de loopback.

## 3. Configurar la app

1. Abre la app y pulsa **⚙️ Ajustes**.
2. Pega el **Client ID** y pulsa **Conectar con Spotify**.
3. Elige dónde suena la música: *esta tablet* u *otro dispositivo Spotify*.
4. Elige la lista de la **NOCHE** 🌙 y la del **DÍA** ☀️ (de tus listas, o pegando un enlace
   de Spotify de cualquier playlist, álbum o artista). El botón **Probar** las prueba al vuelo.
5. En **Temporizadores** ajusta la progresión y, si quieres, fija rondas concretas a mano.

## 4. Dirigir la partida

| Acción | Botón | Teclado |
|---|---|---|
| Iniciar / pausar | ▶ Iniciar | `espacio` |
| Sumar o restar un minuto | +1 min / −1 min | |
| Siguiente fase (noche → día → noche…) | Siguiente fase ⏭ | `→` |
| Fase anterior | ⏮ Fase anterior | `←` |
| Reiniciar la fase actual | ↺ Reiniciar fase | `R` |
| Pausar o reanudar la música | ⏯ Música | |
| Saltar de canción | ⏭ Canción | |
| Pantalla completa | ⛶ | `F` |

Al entrar en una fase, la app arranca su lista con un fundido; al llegar el reloj a cero
suena la campanada y (si está activado *pasar solo a la siguiente fase*) cambia la fase
y con ella la música. Así la noche y el día suenan siempre distintos sin tocar nada.

## 5. Cómo se calculan las duraciones

Para cada ronda, la fase elegida en *«La progresión se aplica a»* dura:

```
duración(ronda) = máx( suelo , primera_ronda − bajada × (ronda − 1) )
```

Con los valores por defecto (10, −2, suelo 6) sale: **10, 8, 6, 6, 6…**
La otra fase usa la duración fija indicada al lado. Cualquier casilla escrita a mano
manda sobre la fórmula, se marca en color y se guarda en la tablet.

## 6. Notas

- La configuración, las listas y la sesión de Spotify se guardan en el navegador de la tablet
  (`localStorage`); no se envía nada a ningún servidor ajeno a Spotify.
- El reproductor integrado necesita un navegador moderno (Chrome, Edge, Safari 16+) y que la
  página se sirva por `https://` (o `127.0.0.1`).
- iPad/iOS restringe la reproducción en segundo plano: si bloqueas la pantalla, es mejor usar
  la opción *otro dispositivo Spotify* y dejar sonando un altavoz o el móvil.
- Si el reloj llega a cero con la app en segundo plano, al volver muestra el tiempo correcto:
  la cuenta atrás se calcula con marcas de tiempo reales, no sumando ticks.

## Estructura

```
index.html        Interfaz
css/styles.css    Tema oscuro, dos paletas (noche y día)
js/app.js         Estado de la partida, fases y enlace con la interfaz
js/spotify.js     OAuth PKCE, Web API, Web Playback SDK y fundidos
js/schedule.js    Cálculo de la duración de cada ronda
js/timer.js       Cuenta atrás por marcas de tiempo
js/store.js       Configuración persistente
js/audio.js       Campanada sintetizada (Web Audio)
```
