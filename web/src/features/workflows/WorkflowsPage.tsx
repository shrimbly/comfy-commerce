import type { Workflow } from '@comfy-commerce/shared'
import { ICON, IconBox, LayoutGrid, List } from '../../lib/icons.js'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'

import { useDeleteWorkflow, useWorkflows } from '../../api/hooks.js'
import { UploadCloudIcon } from '../../lib/animated-icons/UploadCloudIcon.js'
import { useHover } from '../../lib/useHover.js'
import { Button } from '../../components/ui/Button.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { PageHeader } from '../../components/ui/PageHeader.js'
import { Segmented } from '../../components/ui/Segmented.js'
import { Skeleton } from '../../components/ui/Skeleton.js'
import { staggerChild, staggerParent } from '../../lib/motion.js'
import { EditWorkflowDialog } from './EditWorkflowDialog.js'
import { UploadWorkflowDialog } from './UploadWorkflowDialog.js'
import { WorkflowCard } from './WorkflowCard.js'
import { WorkflowDetailDialog } from './WorkflowDetailDialog.js'
import { WorkflowRow } from './WorkflowRow.js'

type Layout = 'list' | 'grid'

const LAYOUT_STORAGE_KEY = 'workflows.layout'

function loadLayout(): Layout {
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (stored === 'grid' || stored === 'list') return stored
  }
  return 'grid'
}

function WorkflowRowSkeleton() {
  return (
    <div className="flex items-center gap-4 border-b border-line px-4 py-3 last:border-b-0">
      <Skeleton className="size-12 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3 w-56" />
      </div>
      <Skeleton className="h-3.5 w-12 shrink-0" />
    </div>
  )
}

function WorkflowCardSkeleton() {
  return (
    <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-line">
      <Skeleton className="absolute inset-0 rounded-none" />
      <div className="absolute inset-x-1 bottom-1 rounded-xl bg-surface px-3 py-2">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="mt-1.5 h-3 w-1/2" />
      </div>
    </div>
  )
}

/** Loading placeholder for one collection, matching the active layout. */
function SkeletonCollection({ layout, count }: { layout: Layout; count: number }) {
  const items = Array.from({ length: count })
  return layout === 'grid' ? (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
      {items.map((_, i) => (
        <WorkflowCardSkeleton key={i} />
      ))}
    </div>
  ) : (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
      {items.map((_, i) => (
        <WorkflowRowSkeleton key={i} />
      ))}
    </div>
  )
}

/** First-load skeleton mirroring the page's two sections. */
function WorkflowsSkeleton({ layout }: { layout: Layout }) {
  return (
    <div className="space-y-6">
      <section>
        <div className="mb-3 flex items-center justify-between gap-4">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-8 w-40 rounded-lg" />
        </div>
        <SkeletonCollection layout={layout} count={3} />
      </section>
      <section>
        <Skeleton className="mb-3 h-5 w-24" />
        <SkeletonCollection layout={layout} count={6} />
      </section>
    </div>
  )
}

export function WorkflowsPage() {
  const { data: workflows = [], isPending } = useWorkflows()
  const deleteWorkflow = useDeleteWorkflow()
  const [uploadOpen, setUploadOpen] = useState(false)
  const [editing, setEditing] = useState<Workflow | null>(null)
  const [viewing, setViewing] = useState<Workflow | null>(null)
  const [layout, setLayout] = useState<Layout>(loadLayout)
  const headerUpload = useHover()
  const emptyUpload = useHover()

  useEffect(() => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, layout)
  }, [layout])

  const mine = workflows.filter((w) => w.source === 'user')
  const builtins = workflows.filter((w) => w.source === 'builtin')

  // Render a collection as the active layout. Editable collections (user
  // workflows) get edit/delete affordances; built-ins don't.
  const renderCollection = (items: Workflow[], editable: boolean) =>
    layout === 'grid' ? (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <AnimatePresence mode="popLayout">
          {items.map((workflow) => (
            <WorkflowCard
              key={workflow.id}
              workflow={workflow}
              onSelect={() => setViewing(workflow)}
              onEdit={editable ? () => setEditing(workflow) : undefined}
              onDelete={editable ? () => deleteWorkflow.mutate(workflow.id) : undefined}
            />
          ))}
        </AnimatePresence>
      </div>
    ) : (
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
        <AnimatePresence mode="popLayout">
          {items.map((workflow) => (
            <WorkflowRow
              key={workflow.id}
              workflow={workflow}
              onSelect={() => setViewing(workflow)}
              onEdit={editable ? () => setEditing(workflow) : undefined}
              onDelete={editable ? () => deleteWorkflow.mutate(workflow.id) : undefined}
            />
          ))}
        </AnimatePresence>
      </div>
    )

  return (
    <>
      <PageHeader
        subtitle="Upload your own, or use the built-ins."
        actions={
          <Button variant="primary" onClick={() => setUploadOpen(true)} {...headerUpload.props}>
            <IconBox>
              <UploadCloudIcon size={18} animate={headerUpload.state} />
            </IconBox>
            Upload workflow
          </Button>
        }
      />

      {isPending ? (
        // First load: skeleton the two sections (never the empty state, which
        // would otherwise flash "No uploads yet" before the workflows arrive).
        <WorkflowsSkeleton layout={layout} />
      ) : (
        <motion.div variants={staggerParent} initial="initial" animate="animate" className="space-y-6">
          <motion.section variants={staggerChild}>
            <div className="mb-3 flex items-center justify-between gap-4">
              <h2 className="text-base font-medium">Your workflows</h2>
              <Segmented<Layout>
                value={layout}
                onChange={setLayout}
                options={[
                  { value: 'list', label: 'List', icon: <List {...ICON} /> },
                  { value: 'grid', label: 'Grid', icon: <LayoutGrid {...ICON} /> },
                ]}
              />
            </div>
            {mine.length === 0 ? (
              <EmptyState
                title="No uploads yet"
                body={
                  <>
                    Upload a ComfyUI workflow, use{' '}
                    <a
                      href="https://docs.comfy.org/interface/app-mode"
                      target="_blank"
                      rel="noreferrer"
                      className="text-ink underline"
                    >
                      App Mode
                    </a>{' '}
                    to pick its inputs and outputs. Include at least one Load Image node.
                  </>
                }
                action={
                  <Button variant="secondary" onClick={() => setUploadOpen(true)} {...emptyUpload.props}>
                    <IconBox>
                      <UploadCloudIcon size={18} animate={emptyUpload.state} />
                    </IconBox>
                    Upload workflow
                  </Button>
                }
              />
            ) : (
              renderCollection(mine, true)
            )}
          </motion.section>

          <motion.section variants={staggerChild}>
            <h2 className="mb-3 text-base font-medium">Built-in</h2>
            {renderCollection(builtins, false)}
          </motion.section>
        </motion.div>
      )}

      <UploadWorkflowDialog open={uploadOpen} onClose={() => setUploadOpen(false)} />
      <EditWorkflowDialog workflow={editing} onClose={() => setEditing(null)} />
      <WorkflowDetailDialog workflow={viewing} onClose={() => setViewing(null)} />
    </>
  )
}
