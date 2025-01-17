import * as pako from 'pako'
import { OpenAPIRoute, Query, Str, Enumeration } from '@cloudflare/itty-router-openapi'

import { saveShortLink } from './Shorten'

import { sendMixpanelEvent }  from '../mixpanel'
import { Env } from '..';

async function fetchMermaidSVG(link: string): Promise<string> {
  const response = await fetch(link);

  if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.text();

  if (data.includes("Syntax error in graph")) {
      throw new Error('SVG contains "Syntax error in graph"');
  }

  return data;
}

function compressAndEncodeBase64(input: string) {
  // Convert the input string to a Uint8Array
  const textEncoder = new TextEncoder()
  const inputUint8Array = textEncoder.encode(input)

  // Compress the Uint8Array using pako's deflate function
  const compressedUint8Array = pako.deflate(inputUint8Array) //, { level: 8 });

  // Encode the compressed Uint8Array to a Base64 string
  const base64Encoded = btoa(
    String.fromCharCode.apply(null, compressedUint8Array)
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

  return base64Encoded
}

function encodeBase64(input: string) {
  // Convert the input string to a Uint8Array
  const textEncoder = new TextEncoder()
  const inputUint8Array = textEncoder.encode(input)

  // Encode the compressed Uint8Array to a Base64 string
  const base64Encoded = btoa(String.fromCharCode.apply(null, inputUint8Array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

  return base64Encoded
}

export interface Interaction {
  role: string
  content: string
}

export async function getGPTResponse(
  userQuestion: string,
  env: any
): Promise<string> {
  const apiKey = env.OPENAI_KEY as string
  const store = env.CHAT_HISTORY as KVNamespace

  let historyString = await store.get('CHAT_HISTORY')

  let history: Interaction[] = []
  if (
    true || // UNTIL WE HAVE AUTHENTICATION, WE WILL JUST START A NEW CHAT EVERY TIME
    historyString === null ||
    historyString === undefined
  ) {
    console.log("No history, let's start a new one")
    history = [
      {
        role: 'system',
        content: 'system prompt goes here, not used rn'
      }
    ]
  } else {
    // Get old messages
    console.log('Appending to old history')
    history = JSON.parse(historyString)

    history.push({
      role: 'user',
      content: userQuestion
    })
  }

  console.log('history', history)

  const apiUrl = `https://api.openai.com/v1/chat/completions`
  let chatRequest = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: history,
      temperature: 0.7
    })
  })

  const response: any = await chatRequest.json()
  let textReply = response.choices[0].message.content

  // Add to history as assistant
  history.push({
    role: 'assistant',
    content: textReply
  })

  // Save history
  await store.put('CHAT_HISTORY', JSON.stringify(history))

  return textReply
}

export class MermaidRoute extends OpenAPIRoute {
  /// 2. Creates /openapi.json route under the hood. Injects this into gpt prompt to teach about how to use the plugin.
  static schema = {
    tags: ["Diagram", "Mermaid"],
    summary: `Taking in a mermaid graph diagram, renders it and returns a link to the rendered image.`,
    parameters: {
      mermaid: Query(
        new Str({
          description: "Diagram to render",
          example: `graph TB\\n  U[\\"User\\"] -- \\"File Operations\\" --> FO[\\"File Operations\\"]\\n  U -- \\"Code Editor\\" --> CE[\\"Code Editor\\"]\\n  FO -- \\"Manipulation of Files\\" --> FS[\\"FileSystem\\"]\\n  FS -- \\"Write/Read\\" --> D[\\"Disk\\"]\\n  FS -- \\"Compress/Decompress\\" --> ZL[\\"ZipLib\\"]\\n  FS -- \\"Read\\" --> IP[\\"INIParser\\"]\\n  CE -- \\"Create/Display/Edit\\" --> WV[\\"Webview\\"]\\n  CE -- \\"Language/Code Analysis\\" --> VCA[\\"VSCodeAPI\\"]\\n  VCA -- \\"Talks to\\" --> VE[\\"ValidationEngine\\"]\\n  WV -- \\"Render UI\\" --> HC[\\"HTMLCSS\\"]\\n  VE -- \\"Decorate Errors\\" --> ED[\\"ErrorDecoration\\"]\\n  VE -- \\"Analyze Document\\" --> TD[\\"TextDocument\\"]\\n`,
        }),
        {
          required: true,
        }
      ),
    },
    responses: {
      "200": {
        schema: {
          results: [
            {
              image: new Str({
                description: "URL to the rendered image",
                required: false,
              }),
              errorMessage: new Str({
                description: "Error message if there was an error",
                required: false,
              }),
              editDiagramOnline: new Str({
                description:
                  "URL to the editor where the diagram can be edited",
              }),
              contributeToOpenSourceProject: new Str({
                description: "GitHub URL to the open source project for this project",
              }),
            },
          ],
        },
      },
    },
  }

  /// 3. Handles the API request
  async handle(request: Request, env: Env, _ctx, data: Record<string, any>) {
    const BASE_URL = new URL(request.url).origin
    const timeline = new Timeline();

    // Extract data from request
    const diagramLanguage = 'mermaid' as string
    let mermaid = new URL(request.url).searchParams.get("mermaid");
    console.log('snippet', mermaid)

    const diagramType = mermaid.split('\n')[0]

    // Print headers
    const headers = Object.fromEntries(request.headers)
    console.log('headers', headers)

    const conversationId = headers['openai-conversation-id']
    const ephemeralUserId = headers['openai-ephemeral-user-id']
    const realIP = headers['x-real-ip']

    // Track render event
    const track = async (event: string, properties: Record<string, any>) => {
      try {
        const adjustedProperties = {
          ...properties,
          'conversation_id': conversationId,

          ip: realIP,
          'worker_environment': env.WORKER_ENV,
        }
        await sendMixpanelEvent(env.MIXPANEL_TOKEN as string, event, ephemeralUserId, adjustedProperties)
        console.log('Sent mixpanel event', event, properties)
      } catch (e) {
        console.log('Error sending mixpanel event', e)
      }
    }
    void track('render', {
      'diagram_language': diagramLanguage,

      // Mixpanel truncates all strings https://developer.mixpanel.com/reference/import-events#common-issues
      'diagram_type': diagramType,
      'diagram': mermaid.length > 255 ? mermaid.substring(0, 200) + " -- truncated" : mermaid,
    })

    let mermaidNoPluses: string
    // Means we are in gpt-4 mode 
    // TODO: Clean this up - GPT-4 mode is unused
    if (mermaid === undefined) {
      const queryNoPluses = mermaid.replace(/\+/g, ' ')

      // GPT Plugins encoded spaces as +
      mermaidNoPluses = await getGPTResponse(queryNoPluses, env)
      timeline.finishGPTResponse()
    } else {
      // GPT Plugins encoded spaces as +
      mermaidNoPluses = mermaid.replace(/\+/g, ' ')
    }

    console.log('mermaidNoPluses before styling')
    console.log(mermaidNoPluses)

    // Breaks for other diagram styles, for instance sequence diagrams
    if (mermaidNoPluses.startsWith('graph')) {
      // TODO hoist regex to only generate once
      const MERMAID_LINK_PATTERN = /-->/g;
      const linksCount = (mermaidNoPluses.match(MERMAID_LINK_PATTERN) || []).length;
      mermaidNoPluses += '\n';
      for (let i = 0; i  < linksCount; i++) {
        mermaidNoPluses += `  linkStyle ${i} stroke:#2ecd71,stroke-width:2px;\n`;
      }
    }

    console.log('mermaidNoPluses after styling')
    console.log(mermaidNoPluses)

    let diagramSource = mermaidNoPluses

    let editDiagramOnline = None;
    switch (diagramLanguage) {
      case 'blockdiag':
        break;
      case 'bpmn':
        break;
      case 'bytefield':
        break;
      case 'seqdiag':
        break;
      case 'actdiag':
        break;
      case 'nwdiag':
        break;
      case 'packetdiag':
        break;
      case 'rackdiag':
        break;
      case 'c4-with-plantuml':
        break;
      case 'd2':
        break;
      case 'dbml':
        break;
      case 'ditaa':
        break;
      case 'erd':
        break;
      case 'excalidraw':
        break;
      case 'graphviz':
        break;
      case 'mermaid':
        editDiagramOnline = Some(mermaidEditorLink(diagramSource));
        break;
      case 'nomnoml':
        break;
      case 'pikchr':
        break;
      case 'plantuml':
        break;
      case 'structurizr':
        break;
      case 'svgbob':
        break;
      case 'umlet':
        break;
      case 'vega':
        break;
      case 'vega-lite':
        break;
      case 'wavedrom':
        break;
      case 'wireviz':
        break;
    }


    // TODO: Add graphvis editor https://www.devtoolsdaily.com/graphviz/?#%7B%22dot%22%3A%22digraph%20MessageArchitecture%20%7B%5Cn%20%20messageClient%5Cn%20%20messageQueue%5Bshape%3Drarrow%5D%5Cn%7D%22%7D

    // Does not support mindmaps
    const imageUrl =
       'https://kroki.io/' +
       diagramLanguage +
       '/svg/' +
       compressAndEncodeBase64(diagramSource)

    let mermaidIsValid = false
    try {
      const mermaidSVG = await fetchMermaidSVG(imageUrl)
      mermaidIsValid = true
      // TODO: Put the svg in the KV store instead of putting the link
    } catch (error) {
      console.error(`Error rendering or fetching mermaid svg: ${error}`)
    }

    const slug = await saveShortLink(env.SHORTEN, imageUrl)
    let shortenedURL = `${BASE_URL}/s/${slug}`

    const editorSlug = await saveShortLink(env.SHORTEN, editDiagramOnline)

    let shortenedEditDiagramURL = `${BASE_URL}/s/${editorSlug}`

    console.log({ shortenedURL })
    console.log('kroki url', imageUrl)

    // NOTE: Seems like render_complete are being sent based on logs, but not showing up in mixpanel
    // suspecting that the response is being sent before the event is sent and all promises are being cleaned up
    await track('render_complete', {
      'diagram_language': diagramLanguage,
      'diagram_syntax_is_valid': mermaidIsValid,

      'diagram_type': diagramType,
      'diagram_url': shortenedURL,
      'edit_diagram_url': shortenedEditDiagramURL,
    })

    let responseBody: any
    if (mermaidIsValid) {
      responseBody = {
        results: [
          {
            image: shortenedURL,
            editDiagramOnline: shortenedEditDiagramURL,
            contributeToOpenSourceProject: 'https://github.com/bra1nDump/show-me-chatgpt-plugin/issues'
          }
        ]
      }
    } else {
      responseBody = {
        results: [
          {
            errorMessage: "GPT created an invalid mermaid.js diagram, you can try again or edit it online",
            editDiagramOnline: shortenedEditDiagramURL,
            contributeToOpenSourceProject: 'https://github.com/bra1nDump/show-me-chatgpt-plugin/issues'
          }
        ]
      }
    }

    return new Response(
      JSON.stringify(responseBody),
      {
        headers: {
          'content-type': 'application/json;charset=UTF-8'
        }
      }
    )
  }
}

function mermaidEditorLink(code: string): string {
    const mermaidEditorJson = {
      code,
      mermaid: { theme: 'default' },
      updateEditor: false
    }
    const mermaidEditorJsonString = JSON.stringify(mermaidEditorJson)
    const buffer = encodeBase64(mermaidEditorJsonString)

    return 'https://mermaid.live/edit#' + buffer
}

export function RenderRoute(request: Request, data: Record<string, any>) {
  console.log('\n\nPreview')
  console.log(request.url)
  const searchParams = new URL(request.url).searchParams
  const mermaid = searchParams.get('mermaid')

  const html = `
<!DOCTYPE html>
<html lang="en" style="background: rgb(247, 247, 248)">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenGraph Image Example</title>
  <meta property="og:url" content="https://dexa.ai/lex/episodes/doc_358?sectionSid=sec_5319&chunkSid=chunk_9725">
  <meta property="og:type" content="website">
  <meta property="og:title" content="Daniel Negreanu: Poker | Lex Fridman Podcast #324">
  <meta property="og:description" content="undefined">
  <meta property="og:image" content="https://dexa.ai/resources/chunk/image/chunk_9725.png">
  <link rel="stylesheet"
href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">

</head>
<script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
  </script>
  <body style="background: rgb(247, 247, 248)">
    <pre class="mermaid" style="width: 100vw">
        ${mermaid.replace(/\+/g, ' ')}
    </pre>
  </body>
  <style>svg {
   max-width: none !important;
   max-height: 100vh !important;
  }</style>
</html>
  `

  return new Response(html, {
    headers: {
      'content-type': 'text/html;charset=UTF-8'
    }
  })
}

class Timeline {
  private start: Date;
  private endOfGPTResponse: Option<Date>;
  constructor() {
    this.start = new Date();
  }

  finishGPTResponse() {
    this.endOfGPTResponse = new Date();
    console.log(
      'time gpt responded: ',
      (this.endOfGPTResponse.getTime() - this.start.getTime()) / 1000
    )
  }

  finish() {

  }
}

type Option<T> = T | null;
const None: Option<any> = null;
function Some<T>(a: T): Option<T> { return a }
