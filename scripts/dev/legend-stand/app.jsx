import React from 'react';
import { createRoot } from 'react-dom/client';
import { LegendList } from '@legendapp/list/react';

const data = Array.from({ length: 60 }, (_, i) => ({ id: String(i), name: `Token ${i}` }));

function Row({ item }) {
  // FOMO's enter animation: the grid row opens from 0fr to 1fr over 150ms.
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => { const id = requestAnimationFrame(() => setOpen(true)); return () => cancelAnimationFrame(id); }, []);
  return (
    <div className="grid" data-state="closed" style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0, transition: 'grid-template-rows 150ms ease-out, opacity 150ms ease-out' }}>
      <div className="overflow-hidden">
        <a href={`/tokens/x/${item.id}`} className="row" style={{ display: 'flex', minHeight: 52, boxSizing: 'border-box', padding: 8 }}>
          <span className="truncate">{item.name}</span>
        </a>
      </div>
    </div>
  );
}

function App() {
  return (
    <div style={{ width: 340, height: 600, display: 'flex', flexDirection: 'column' }}>
      <LegendList
        data={data}
        estimatedItemSize={53}
        getFixedItemSize={() => 53}

        dataKey="tokens"
        getItemType={() => 'token'}
        viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}
        onViewableItemsChanged={() => {}}
        keyExtractor={(item) => item.id}
        recycleItems
        renderItem={({ item }) => <Row item={item} />}
        ItemSeparatorComponent={() => <div className="h-px" style={{ height: 1 }} />}
        style={{ flex: 1 }}
        className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 px-1"
      />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
