import React from 'react';
import Head from '@docusaurus/Head';
import { useDoc } from '@docusaurus/plugin-content-docs/client';
import { usePluginData } from '@docusaurus/useGlobalData';
// A plugin that wraps a theme component imports the theme's own (@theme-init); @theme-original would be this file.
import Original from '@theme-init/DocItem/Footer';
import { renderStampFooter } from '../../../stamp-slot.js';

export default function StaleproofDocFooter(props) {
  return renderStampFooter({ React, Head, useDoc, usePluginData, Original }, props);
}
