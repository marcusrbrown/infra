import starlight from '@astrojs/starlight'
import {defineConfig} from 'astro/config'

import {SERVICES} from './src/data/services.ts'

// Project site under the user site's custom domain; no analytics, no external fonts or CDNs.
export default defineConfig({
  site: 'https://mrbro.dev',
  base: '/infra',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'infra',
      description: 'Operator docs and architecture for the infra deploy packages.',
      social: [{icon: 'github', label: 'GitHub', href: 'https://github.com/marcusrbrown/infra'}],
      sidebar: [
        {label: 'Status', link: '/status/'},
        {
          label: 'Services',
          items: Object.entries(SERVICES).map(([app, info]) => ({label: info.title, link: `/services/${app}/`})),
        },
        {label: 'Guides', items: [{autogenerate: {directory: 'guides'}}]},
        {label: 'Runbooks', items: [{autogenerate: {directory: 'runbooks'}}]},
        {label: 'Solutions', items: [{autogenerate: {directory: 'solutions'}}]},
        {label: 'Architecture', items: [{autogenerate: {directory: 'architecture'}}, {slug: 'diagrams'}]},
      ],
    }),
  ],
})
