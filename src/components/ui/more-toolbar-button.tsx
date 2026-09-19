'use client';

import * as React from 'react';

import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';

import { TextAlignPlugin } from '@platejs/basic-styles/react';
import { ListStyleType, toggleList } from '@platejs/list';
import {
  TextAlignCenterIcon as AlignCenterIcon,
  TextAlignJustifyIcon as AlignJustifyIcon,
  TextAlignLeftIcon as AlignLeftIcon,
  TextAlignRightIcon as AlignRightIcon,
  KeyboardIcon,
  ListIcon as List,
  ListNumbersIcon as ListOrdered,
  DotsThreeIcon as MoreHorizontalIcon,
  TextSubscriptIcon as SubscriptIcon,
  TextSuperscriptIcon as SuperscriptIcon,
} from "@phosphor-icons/react";
import { KEYS } from 'platejs';
import { useEditorPlugin, useEditorRef } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { ToolbarButton } from './toolbar';

export function MoreToolbarButton(props: DropdownMenuProps) {
  const editor = useEditorRef();
  const { tf: alignTf } = useEditorPlugin(TextAlignPlugin);
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false} {...props}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton pressed={open} tooltip="More">
          <MoreHorizontalIcon />
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="ignore-click-outside/toolbar flex max-h-[500px] min-w-[180px] flex-col overflow-y-auto"
        align="start"
      >
        {/* Block-level formatting — these lived only in the old fixed bar. */}
        <DropdownMenuLabel>Alignement</DropdownMenuLabel>
        <DropdownMenuGroup>
          {(
            [
              ['left', AlignLeftIcon, 'Gauche'],
              ['center', AlignCenterIcon, 'Centre'],
              ['right', AlignRightIcon, 'Droite'],
              ['justify', AlignJustifyIcon, 'Justifié'],
            ] as const
          ).map(([value, Icon, label]) => (
            <DropdownMenuItem
              key={value}
              onSelect={() => {
                alignTf.textAlign.setNodes(value);
                editor.tf.focus();
              }}
            >
              <Icon />
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuLabel>Listes</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem
            onSelect={() => {
              toggleList(editor, { listStyleType: ListStyleType.Disc });
              editor.tf.focus();
            }}
          >
            <List />
            Liste à puces
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              toggleList(editor, { listStyleType: ListStyleType.Decimal });
              editor.tf.focus();
            }}
          >
            <ListOrdered />
            Liste numérotée
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem
            onSelect={() => {
              editor.tf.toggleMark(KEYS.kbd);
              editor.tf.collapse({ edge: 'end' });
              editor.tf.focus();
            }}
          >
            <KeyboardIcon />
            Touche clavier
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={() => {
              editor.tf.toggleMark(KEYS.sup, { remove: KEYS.sub });
              editor.tf.focus();
            }}
          >
            <SuperscriptIcon />
            Exposant
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              editor.tf.toggleMark(KEYS.sub, { remove: KEYS.sup });
              editor.tf.focus();
            }}
          >
            <SubscriptIcon />
            Indice
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
