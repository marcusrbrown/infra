import starlight from '@astrojs/starlight'
import {defineConfig} from 'astro/config'

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
        {label: 'Services', items: [{autogenerate: {directory: 'services'}}]},
        {label: 'Guides', items: [{autogenerate: {directory: 'guides'}}]},
        {label: 'Runbooks', items: [{autogenerate: {directory: 'runbooks'}}]},
        {label: 'Solutions', items: [{autogenerate: {directory: 'solutions'}}]},
        {label: 'Architecture', items: [{autogenerate: {directory: 'architecture'}}, {slug: 'diagrams'}]},
      ],
    }),
  ],
})
