import * as React from 'react';
import { useEventCallback } from '@mui/material/utils';
import { GridApiCommunity } from '../../../models/api/gridApiCommunity';
import { DataGridProcessedProps } from '../../../models/props/DataGridProps';
import {
  useGridApiOptionHandler,
  useGridApiEventHandler,
} from '../../utils/useGridApiEventHandler';
import {
  GridCellModes,
  GridEditModes,
  GridEditCellProps,
  GridEditRowsModel,
} from '../../../models/gridEditRowModel';
import {
  isKeyboardEvent,
  isPrintableKey,
  isCellEnterEditModeKeys,
  isCellExitEditModeKeys,
  isCellEditCommitKeys,
  isDeleteKeys,
} from '../../../utils/keyboardUtils';
import { GridEventListener } from '../../../models/events/gridEventListener';
import { useGridLogger } from '../../utils/useGridLogger';
import { gridFocusCellSelector } from '../focus/gridFocusStateSelector';
import { GridCellParams } from '../../../models/params/gridCellParams';
import { MuiBaseEvent } from '../../../models/muiEvent';
import { useGridApiMethod } from '../../utils/useGridApiMethod';
import {
  GridEditingApi,
  GridCellEditingApi,
  GridEditingSharedApi,
} from '../../../models/api/gridEditingApi';
import {
  GridCellEditCommitParams,
  GridCellEditStartParams,
  GridCellEditStopParams,
} from '../../../models/params/gridEditCellParams';
import { gridEditRowsStateSelector } from './gridEditRowsSelector';
import { GridCellMode } from '../../../models/gridCell';

function isPromise(promise: any): promise is Promise<GridEditCellProps> {
  return typeof promise.then === 'function';
}

export const useCellEditing = (
  apiRef: React.MutableRefObject<GridApiCommunity>,
  props: Pick<
    DataGridProcessedProps,
    'editMode' | 'onCellEditCommit' | 'onCellEditStart' | 'onCellEditStop' | 'experimentalFeatures'
  >,
) => {
  const logger = useGridLogger(apiRef, 'useGridEditRows');

  const buildCallback =
    <Args extends any[]>(callback: (...args: Args) => void) =>
    (...args: Args) => {
      if (props.editMode === GridEditModes.Cell) {
        callback(...args);
      }
    };

  const setCellMode = React.useCallback<GridEditingApi['setCellMode']>(
    (id, field, mode: GridCellMode) => {
      if (apiRef.current.getCellMode(id, field) === mode) {
        return;
      }

      logger.debug(`Switching cell id: ${id} field: ${field} to mode: ${mode}`);
      apiRef.current.setState((state) => {
        const newEditRowsState: GridEditRowsModel = { ...state.editRows };
        newEditRowsState[id] = { ...newEditRowsState[id] };
        if (mode === GridCellModes.Edit) {
          newEditRowsState[id][field] = { value: apiRef.current.getCellValue(id, field) };
        } else {
          delete newEditRowsState[id][field];
          if (!Object.keys(newEditRowsState[id]).length) {
            delete newEditRowsState[id];
          }
        }
        return { ...state, editRows: newEditRowsState };
      });
      apiRef.current.forceUpdate();
      apiRef.current.publishEvent('cellModeChange', apiRef.current.getCellParams(id, field));
    },
    [apiRef, logger],
  );

  const getCellMode = React.useCallback<GridEditingApi['getCellMode']>(
    (id, field) => {
      const editRowsState = gridEditRowsStateSelector(apiRef.current.state);
      const isEditing = editRowsState[id] && editRowsState[id][field];
      return isEditing ? GridCellModes.Edit : GridCellModes.View;
    },
    [apiRef],
  );

  // TODO v6: it should always return a promise
  const commitCellChange = React.useCallback<GridEditingApi['commitCellChange']>(
    (params, event = {}) => {
      const { id, field } = params;

      apiRef.current.unstable_runPendingEditCellValueMutation(id, field);

      const model = apiRef.current.getEditRowsModel();
      if (!model[id] || !model[id][field]) {
        throw new Error(`MUI: Cell at id: ${id} and field: ${field} is not in edit mode.`);
      }

      const editCellProps = model[id][field];
      const column = apiRef.current.getColumn(field);
      const row = apiRef.current.getRow(id)!;

      if (props.experimentalFeatures?.preventCommitWhileValidating) {
        const cellProps = model[id][field];
        if (cellProps.isValidating || cellProps.error) {
          return false;
        }
      }

      const commitParams: GridCellEditCommitParams = {
        ...params,
        value: editCellProps.value,
      };

      let hasError = !!editCellProps.error;
      if (!hasError && typeof column.preProcessEditCellProps === 'function') {
        const result = column.preProcessEditCellProps({ id, row, props: editCellProps });

        if (isPromise(result)) {
          return result.then((newEditCellProps) => {
            apiRef.current.unstable_setEditCellProps({ id, field, props: newEditCellProps });
            if (newEditCellProps.error) {
              return false;
            }
            apiRef.current.publishEvent('cellEditCommit', commitParams, event);
            return true;
          });
        }

        apiRef.current.unstable_setEditCellProps({ id, field, props: result });
        hasError = !!result.error;
      }

      if (!hasError) {
        apiRef.current.publishEvent('cellEditCommit', commitParams, event);
        return true;
      }

      return false;
    },
    [apiRef, props.experimentalFeatures?.preventCommitWhileValidating],
  );

  const setCellEditingEditCellValue = React.useCallback<
    GridCellEditingApi['unstable_setCellEditingEditCellValue']
  >(
    (params) => {
      const column = apiRef.current.getColumn(params.field);
      const row = apiRef.current.getRow(params.id)!;

      return new Promise((resolve) => {
        let newEditCellProps: GridEditCellProps = { value: params.value };
        const model = apiRef.current.getEditRowsModel();
        const editCellProps = model[params.id][params.field];

        if (typeof column.preProcessEditCellProps !== 'function') {
          apiRef.current.unstable_setEditCellProps({ ...params, props: newEditCellProps });
          resolve(true);
          return;
        }

        // setEditCellProps runs the value parser and returns the updated props
        newEditCellProps = apiRef.current.unstable_setEditCellProps({
          ...params,
          props: { ...editCellProps, isValidating: true },
        });

        Promise.resolve(
          column.preProcessEditCellProps({
            id: params.id,
            row,
            props: {
              ...newEditCellProps,
              value: apiRef.current.unstable_parseValue(params.id, params.field, params.value),
            },
          }),
        ).then((newEditCellPropsProcessed) => {
          apiRef.current.unstable_setEditCellProps({
            ...params,
            props: { ...newEditCellPropsProcessed, isValidating: false },
          });
          resolve(!newEditCellPropsProcessed.error);
        });
      });
    },
    [apiRef],
  );

  const cellEditingApi: Omit<GridCellEditingApi, keyof GridEditingSharedApi> = {
    setCellMode,
    getCellMode,
    commitCellChange,
    unstable_setCellEditingEditCellValue: setCellEditingEditCellValue,
  };

  useGridApiMethod(apiRef, cellEditingApi, 'EditRowApi');

  const handleCellKeyDown = React.useCallback<GridEventListener<'cellKeyDown'>>(
    async (params, event) => {
      const { id, field, cellMode, isEditable } = params;
      if (!isEditable) {
        return;
      }

      const isEditMode = cellMode === GridCellModes.Edit;
      const isModifierKeyPressed = event.ctrlKey || event.metaKey || event.altKey;

      if (
        !isEditMode &&
        isCellEnterEditModeKeys(event.key) &&
        !isModifierKeyPressed &&
        !(event.key === ' ' && event.shiftKey)
      ) {
        apiRef.current.publishEvent('cellEditStart', params as GridCellEditStartParams, event);
      }
      if (!isEditMode && isDeleteKeys(event.key)) {
        apiRef.current.setEditCellValue({ id, field, value: '' });
        apiRef.current.commitCellChange({ id, field }, event);
        apiRef.current.publishEvent('cellEditStop', params as GridCellEditStopParams, event);
      }
      if (isEditMode && isCellEditCommitKeys(event.key)) {
        const commitParams = { id, field };
        const isValid = await apiRef.current.commitCellChange(commitParams, event);
        if (!isValid) {
          return;
        }
      }
      if (isEditMode && isCellExitEditModeKeys(event.key)) {
        apiRef.current.publishEvent('cellEditStop', params as GridCellEditStopParams, event);
      }
    },
    [apiRef],
  );

  const handleCellDoubleClick = React.useCallback<GridEventListener<'cellDoubleClick'>>(
    (params, event) => {
      if (!params.isEditable) {
        return;
      }
      apiRef.current.publishEvent('cellEditStart', params as GridCellEditStartParams, event);
    },
    [apiRef],
  );

  const commitPropsAndExit = async (params: GridCellParams, event: MuiBaseEvent) => {
    if (params.cellMode === GridCellModes.View) {
      return;
    }
    await apiRef.current.commitCellChange(params, event);
    apiRef.current.publishEvent('cellEditStop', params as GridCellEditStopParams, event);
  };

  const handleCellFocusOut: GridEventListener<'cellFocusOut'> = useEventCallback(
    (params, event) => {
      commitPropsAndExit(params, event);
    },
  );

  const handleColumnHeaderDragStart: GridEventListener<'columnHeaderDragEnter'> = useEventCallback(
    () => {
      const cell = gridFocusCellSelector(apiRef);
      if (!cell) {
        return;
      }
      const params = apiRef.current.getCellParams(cell.id, cell.field);
      commitPropsAndExit(params, {});
    },
  );

  const handleCellEditStart = React.useCallback<GridEventListener<'cellEditStart'>>(
    (params, event) => {
      if (!params.isEditable) {
        return;
      }

      apiRef.current.setCellMode(params.id, params.field, GridCellModes.Edit);

      if (isKeyboardEvent(event) && isPrintableKey(event.key)) {
        apiRef.current.unstable_setEditCellProps({
          id: params.id,
          field: params.field,
          props: { value: '' },
        });
      }
    },
    [apiRef],
  );

  const handleCellEditStop = React.useCallback<GridEventListener<'cellEditStop'>>(
    (params, event) => {
      apiRef.current.setCellMode(params.id, params.field, GridCellModes.View);

      if (!isKeyboardEvent(event)) {
        return;
      }

      if (isCellEditCommitKeys(event.key)) {
        apiRef.current.publishEvent('cellNavigationKeyDown', params, event);
        return;
      }
      if (event.key === 'Escape' || isDeleteKeys(event.key)) {
        apiRef.current.setCellFocus(params.id, params.field);
      }
    },
    [apiRef],
  );

  const handleCellEditCommit = React.useCallback<GridEventListener<'cellEditCommit'>>(
    (params) => {
      const { id, field } = params;
      const model = apiRef.current.getEditRowsModel();
      const { value } = model[id][field];
      logger.debug(`Setting cell id: ${id} field: ${field} to value: ${value?.toString()}`);
      const row = apiRef.current.getRow(id);
      if (row) {
        const column = apiRef.current.getColumn(params.field);
        let rowUpdate = { ...row, [field]: value };
        if (column.valueSetter) {
          rowUpdate = column.valueSetter({ row, value });
        }
        apiRef.current.updateRows([rowUpdate]);
      }
    },
    [apiRef, logger],
  );

  const handleEditCellPropsChange = React.useCallback<GridEventListener<'editCellPropsChange'>>(
    (params) => {
      const row = apiRef.current.getRow(params.id)!;

      const column = apiRef.current.getColumn(params.field);
      const editCellProps = column.preProcessEditCellProps
        ? column.preProcessEditCellProps({ id: params.id, row, props: params.props })
        : params.props;

      if (isPromise(editCellProps)) {
        editCellProps.then((newEditCellProps) => {
          apiRef.current.unstable_setEditCellProps({ ...params, props: newEditCellProps });
        });
      } else {
        apiRef.current.unstable_setEditCellProps({ ...params, props: editCellProps });
      }
    },
    [apiRef],
  );

  useGridApiEventHandler(apiRef, 'cellKeyDown', buildCallback(handleCellKeyDown));
  useGridApiEventHandler(apiRef, 'cellDoubleClick', buildCallback(handleCellDoubleClick));
  useGridApiEventHandler(apiRef, 'cellFocusOut', buildCallback(handleCellFocusOut));
  useGridApiEventHandler(
    apiRef,
    'columnHeaderDragStart',
    buildCallback(handleColumnHeaderDragStart),
  );
  useGridApiEventHandler(apiRef, 'cellEditStart', buildCallback(handleCellEditStart));
  useGridApiEventHandler(apiRef, 'cellEditStop', buildCallback(handleCellEditStop));
  useGridApiEventHandler(apiRef, 'cellEditCommit', buildCallback(handleCellEditCommit));
  useGridApiEventHandler(apiRef, 'editCellPropsChange', buildCallback(handleEditCellPropsChange));

  useGridApiOptionHandler(apiRef, 'cellEditCommit', props.onCellEditCommit);
  useGridApiOptionHandler(apiRef, 'cellEditStart', props.onCellEditStart);
  useGridApiOptionHandler(apiRef, 'cellEditStop', props.onCellEditStop);
};
